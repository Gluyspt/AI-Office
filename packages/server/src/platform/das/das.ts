// The data access service, implemented. Private — callers use ./contract.ts.
//
// Ticket 034. What this adds over `core/db/pool.ts`, which keeps working
// untouched until each feature is retrofitted:
//
//   - a service boundary on the data layer (grants, which 035 turns into
//     Postgres roles),
//   - a transaction handle that cannot leak a connection, because the caller
//     never holds one,
//   - per-service metrics, which 036 needs to prove a reserved lane works,
//   - a rollback that does not destroy the error that caused it.
//
// The last one is a bug fix, not a tidy-up. See `runTransaction`.
import pg from "pg";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import { loadDatabaseConfig } from "../../core/config.ts";
import {
  RollbackFailedError,
  type DasMetrics,
  type DataAccess,
  type Grant,
  type ServiceMetrics,
  type ServiceName,
  type Tx,
} from "./contract.ts";
import { assertCompatibleGrant, normaliseTables, validateServiceName } from "./grant.ts";

interface Counters {
  inUse: number;
  queries: number;
  transactions: number;
  rollbacks: number;
  checkoutWaitMs: number;
  transactionMs: number;
}

function emptyCounters(): Counters {
  return {
    inUse: 0,
    queries: 0,
    transactions: 0,
    rollbacks: 0,
    checkoutWaitMs: 0,
    transactionMs: 0,
  };
}

export interface DasOptions {
  /** Override the pool. Tests use this to run against a pool of max 1, which
   *  deadlocks on a leaked connection instead of passing quietly. */
  readonly pool?: pg.Pool;
}

class Das implements DataAccess {
  private readonly pool: pg.Pool;
  private readonly grants = new Map<ServiceName, Grant>();
  private readonly counters = new Map<ServiceName, Counters>();

  constructor(options: DasOptions = {}) {
    if (options.pool !== undefined) {
      this.pool = options.pool;
    } else {
      const config = loadDatabaseConfig();
      this.pool = new pg.Pool({
        connectionString: config.url,
        max: config.poolSize,
        statement_timeout: config.statementTimeoutMs,
      });
    }
  }

  private countersFor(service: ServiceName): Counters {
    let found = this.counters.get(service);
    if (found === undefined) {
      found = emptyCounters();
      this.counters.set(service, found);
    }
    return found;
  }

  /**
   * Checks out a connection and hands it back exactly once.
   *
   * `finally` is what makes "exactly once on every path" true by construction
   * rather than by remembering — commit, throw, and a rollback that itself
   * threw all leave through it. The pool-of-one test is what proves it: a
   * leak there deadlocks the next checkout rather than passing.
   */
  private async withClient<T>(
    service: ServiceName,
    run: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const counters = this.countersFor(service);
    const waitStart = Date.now();
    const client = await this.pool.connect();
    counters.checkoutWaitMs += Date.now() - waitStart;
    counters.inUse += 1;
    try {
      return await run(client);
    } finally {
      counters.inUse -= 1;
      client.release();
    }
  }

  private async runQuery<Row extends QueryResultRow>(
    service: ServiceName,
    text: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<Row>> {
    this.countersFor(service).queries += 1;
    return this.withClient(service, (client) =>
      client.query<Row>(text, params as unknown[] | undefined),
    );
  }

  /**
   * One transaction, with the two properties the old `withTransaction` got
   * one-and-a-half of.
   *
   * COMMIT ON RETURN, ROLLBACK ON THROW — unchanged, and 017 depends on it:
   * a refusal decided *after* a write (a scope acquired, then the transition
   * refused because another desk won the race) must leave no locks held, and
   * it does because `ClaimRefused` is thrown rather than returned.
   *
   * THE ORIGINAL ERROR SURVIVES A FAILED ROLLBACK. The old implementation
   * did `catch { await client.query("ROLLBACK"); throw error }`, so a
   * `ROLLBACK` that threw replaced the real error with its own. That path
   * fires precisely when the database is in trouble — a dead connection, a
   * terminated backend — which is when the original message is the only
   * thing that would have explained anything. Now the first error is
   * rethrown and the rollback's failure rides along as its `cause`.
   */
  private async runTransaction<T>(service: ServiceName, run: (tx: Tx) => Promise<T>): Promise<T> {
    const counters = this.countersFor(service);
    counters.transactions += 1;
    const started = Date.now();

    try {
      return await this.withClient(service, async (client) => {
        await client.query("BEGIN");

        const tx: Tx = {
          service,
          query: <Row extends QueryResultRow = QueryResultRow>(
            text: string,
            params?: readonly unknown[],
          ): Promise<QueryResult<Row>> => {
            counters.queries += 1;
            return client.query<Row>(text, params as unknown[] | undefined);
          },
        };

        let result: T;
        try {
          result = await run(tx);
        } catch (error) {
          counters.rollbacks += 1;
          try {
            await client.query("ROLLBACK");
          } catch (rollbackError) {
            // Attach, never replace. See the header.
            if (error instanceof Error && error.cause === undefined) {
              error.cause = new RollbackFailedError(rollbackError);
            }
          }
          throw error;
        }

        await client.query("COMMIT");
        return result;
      });
    } finally {
      counters.transactionMs += Date.now() - started;
    }
  }

  grant(service: ServiceName, tables: readonly string[]): Grant {
    validateServiceName(service);

    const existing = this.grants.get(service);
    if (existing !== undefined) {
      assertCompatibleGrant(service, existing.tables, normaliseTables(service, tables));
      return existing;
    }

    const normalised = normaliseTables(service, tables);
    const grant: Grant = {
      service,
      tables: normalised,
      query: <Row extends QueryResultRow = QueryResultRow>(
        text: string,
        params?: readonly unknown[],
      ): Promise<QueryResult<Row>> => this.runQuery<Row>(service, text, params),
      tx: <T>(run: (tx: Tx) => Promise<T>): Promise<T> => this.runTransaction(service, run),
    };

    this.grants.set(service, grant);
    this.countersFor(service);
    return grant;
  }

  metrics(): DasMetrics {
    const services: ServiceMetrics[] = [...this.counters.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([service, c]) => ({
        service,
        inUse: c.inUse,
        queries: c.queries,
        transactions: c.transactions,
        rollbacks: c.rollbacks,
        checkoutWaitMs: c.checkoutWaitMs,
        transactionMs: c.transactionMs,
      }));

    return {
      total: {
        inUse: this.pool.totalCount - this.pool.idleCount,
        idle: this.pool.idleCount,
        waiting: this.pool.waitingCount,
      },
      services,
    };
  }

  async end(): Promise<void> {
    await this.pool.end();
  }
}

/** Builds a DAS. Exported for tests; the process uses the shared one below. */
export function createDas(options: DasOptions = {}): DataAccess {
  return new Das(options);
}

let shared: DataAccess | null = null;

/**
 * The process-wide DAS, built on first use.
 *
 * Lazy on purpose: `loadDatabaseConfig()` throws when `DATABASE_URL` is
 * absent, and a module-level pool would make importing anything that touches
 * the DAS fail at import time in a test that never meant to open a
 * connection. `core/db/pool.ts` builds its pool eagerly, which is one of the
 * reasons its 17 callers are awkward to test.
 */
export function das(): DataAccess {
  shared ??= new Das();
  return shared;
}
