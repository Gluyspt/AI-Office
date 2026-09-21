// Single shared connection pool to the orchestrator database. Pool size and
// statement timeout come from config.ts (DATABASE_POOL_SIZE,
// DATABASE_STATEMENT_TIMEOUT_MS) rather than being hardcoded here, so they
// can be tuned per-environment without a code change.
//
// `pg` is published as CommonJS; importing its named exports directly under
// Node's native ESM loader is unreliable (a well-known node-postgres
// interop gap), so it's imported as a default and destructured.
import pg from "pg";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import { loadDatabaseConfig } from "../config.ts";

const dbConfig = loadDatabaseConfig();

export const pool = new pg.Pool({
  connectionString: dbConfig.url,
  max: dbConfig.poolSize,
  statement_timeout: dbConfig.statementTimeoutMs,
});

export async function query<Row extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: readonly unknown[],
): Promise<QueryResult<Row>> {
  return pool.query<Row>(text, params as unknown[] | undefined);
}

export async function withTransaction<T>(
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
