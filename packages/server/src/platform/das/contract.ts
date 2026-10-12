// The data access service — its public surface.
//
// Ticket 034. The DAS owns *access*: the pool, connection checkout,
// transaction scope, per-service grants, timeouts and metrics. It does not
// own queries. Each feature keeps its own SQL in its own repo module.
//
// THAT SPLIT IS A DECISION ABOUT THIS OFFICE, not about databases. A data
// layer holding every feature's queries would be one file every ticket and
// every agent edits, in a system whose coordination model is "declare your
// file scope and overlapping work is refused" — the ownership registry would
// refuse constantly and the office would serialise. The data boundary has to
// be a boundary, not a bottleneck.
//
// THIS FILE IS THE ONLY ENTRY POINT. `das.ts` and `grant.ts` are private;
// importing them directly would hand a caller the raw pool and make a grant
// advisory rather than enforced. Asserted by tests/boundaries (033's dated
// section of 2026-10-13).
import type { QueryResult, QueryResultRow } from "pg";

/** A service's name, as its grant and (from 035) its Postgres role use it. */
export type ServiceName = string;

/**
 * A handle inside an open transaction.
 *
 * THE ONE VALUE ALLOWED TO CROSS A SERVICE BOUNDARY, and the reason is
 * recorded in `tests/boundaries/crossings.ts` with a ticket against each of
 * the four places it happens. `claim_task` hands one of these to `locks` so
 * the whole claim commits or none of it does; without that, a claim failing
 * at lock acquisition leaves a task `in_progress` that no agent is working on
 * and no "what can I claim" query can see.
 *
 * It is deliberately NOT a `PoolClient`. A caller that cannot reach
 * `client.release()` cannot release a connection out from under the
 * transaction that owns it — the DAS releases, exactly once, on every path.
 */
export interface Tx {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
  /** The service whose grant opened this transaction, for 035's `SET LOCAL ROLE`. */
  readonly service: ServiceName;
}

/**
 * A service's declared access to the database.
 *
 * The table list is declarative data, not a wrapper: 035 turns the same
 * declaration into a Postgres role with real `GRANT`s, and `SET LOCAL ROLE`
 * on checkout, without a single call site changing.
 */
export interface Grant {
  readonly service: ServiceName;
  /** The tables this service may touch. Read by 035 and by the boundary tests. */
  readonly tables: readonly string[];
  /** One statement, its own connection, released before it returns. */
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
  /** Commits what `run` returns; rolls back what it throws. */
  tx<T>(run: (tx: Tx) => Promise<T>): Promise<T>;
}

export interface DataAccess {
  /** The handle for one service. Calling it twice with the same name returns
   *  the same grant — a service has one grant, not one per import site. */
  grant(service: ServiceName, tables: readonly string[]): Grant;
  /** Per-service counters. 036 needs these to prove its reserved lane works,
   *  and the 50 ms ingest budget needs them to stay attributable. */
  metrics(): DasMetrics;
  /** Closes the pool. Process shutdown only. */
  end(): Promise<void>;
}

export interface ServiceMetrics {
  readonly service: ServiceName;
  /** Connections this service is holding right now. */
  readonly inUse: number;
  readonly queries: number;
  readonly transactions: number;
  readonly rollbacks: number;
  /** Milliseconds spent waiting for a connection, summed. */
  readonly checkoutWaitMs: number;
  /** Milliseconds between BEGIN and COMMIT/ROLLBACK, summed. */
  readonly transactionMs: number;
}

export interface DasMetrics {
  readonly total: { readonly inUse: number; readonly idle: number; readonly waiting: number };
  readonly services: readonly ServiceMetrics[];
}

/**
 * A grant asked for a table it does not hold.
 *
 * The DAS cannot see inside an arbitrary SQL string — that check is 035's
 * `grants.test.ts` and, authoritatively, the Postgres role. This error exists
 * for the cases the DAS *can* see, and so the failure has one name wherever
 * it comes from.
 */
export class GrantError extends Error {
  constructor(
    readonly service: ServiceName,
    message: string,
  ) {
    super(message);
    this.name = "GrantError";
  }
}

/**
 * A rollback that itself failed.
 *
 * Carried as the `cause` of the ORIGINAL error, never in place of it. The old
 * `withTransaction` replaced the real error with the rollback's, which fires
 * exactly when the database is in trouble — the moment the original message
 * matters most.
 */
export class RollbackFailedError extends Error {
  constructor(cause: unknown) {
    super("ROLLBACK failed after an error; the original error is this error's cause");
    this.name = "RollbackFailedError";
    this.rollbackCause = cause;
  }
  readonly rollbackCause: unknown;
}

/** Platform depends on platform. See `packages/server/src/platform/README.md`. */
export const dependencies: readonly string[] = [];
