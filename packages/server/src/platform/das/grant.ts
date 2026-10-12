// Grant rules, as pure functions. Private — callers use ./contract.ts.
//
// Ticket 034. The stateful half (checkout, transactions, metrics) is in
// das.ts; everything here is a decision about a declaration, testable with
// no database and no pool.
//
// The repo already splits this way where it matters — `locks/overlap.ts` is
// pure and `locks/registry.ts` is not — and for the same reason: the rules
// are what you want to test exhaustively, and a table of cases should not
// need a connection.
import { GrantError, type ServiceName } from "./contract.ts";

/**
 * A service name must be usable as a Postgres role name, because 035 turns
 * it into one: `<service>_svc`.
 *
 * Checked here rather than discovered in 035, where the failure would be a
 * migration that half-applied. Lowercase letters, digits and underscores
 * only — the set that needs no quoting in SQL. A name needing quotes would
 * work until the first hand-written `SET LOCAL ROLE` forgot them.
 */
const VALID_SERVICE = /^[a-z][a-z0-9_]*$/;

export function validateServiceName(service: ServiceName): void {
  if (service.trim() === "") {
    throw new GrantError(service, "a grant needs a service name");
  }
  if (!VALID_SERVICE.test(service)) {
    throw new GrantError(
      service,
      `"${service}" cannot be a service name. Use lowercase letters, digits and underscores, starting with a letter — `
        + `035 turns this into the Postgres role ${service}_svc, and a name that needs quoting in SQL works right up until the first SET LOCAL ROLE that forgets them.`,
    );
  }
}

/**
 * A table name must be equally plain, and for the same reason: it lands in a
 * `GRANT ... ON <table>` in a generated migration.
 *
 * A schema-qualified name (`public.tasks`) is accepted — one dot, both halves
 * plain — because 035 may well want to be explicit about the schema.
 */
const VALID_TABLE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)?$/;

export function normaliseTables(service: ServiceName, tables: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const table of tables) {
    const trimmed = table.trim();
    if (!VALID_TABLE.test(trimmed)) {
      throw new GrantError(
        service,
        `"${table}" is not a usable table name in ${service}'s grant. Expected something like "tasks" or "public.tasks" — `
          + `this list becomes GRANT statements in a migration, so a name that needs quoting breaks at apply time rather than here.`,
      );
    }
    seen.add(trimmed);
  }
  // Sorted and de-duplicated so two declarations of the same set compare
  // equal, and so a generated migration's statement order is stable.
  return [...seen].sort();
}

/**
 * One service, one grant.
 *
 * Two import sites asking for the same service must get the same handle, or
 * 035's role mapping and 036's lane assignment would depend on which import
 * ran first — a difference that would show up as an intermittent permission
 * error, which is the worst way to learn about it.
 *
 * A second call declaring a DIFFERENT set is a mistake worth refusing rather
 * than merging: merging would mean a service's real table list is the union
 * of whatever happened to be imported, which no single file states and no
 * reviewer can check. A call declaring NO tables is treated as "give me the
 * existing grant", which is how a second call site asks for the handle
 * without restating the declaration.
 */
export function assertCompatibleGrant(
  service: ServiceName,
  existing: readonly string[],
  requested: readonly string[],
): void {
  if (requested.length === 0) return;

  const same =
    existing.length === requested.length && existing.every((table, i) => table === requested[i]);
  if (same) return;

  throw new GrantError(
    service,
    `${service} already holds a grant for [${existing.join(", ")}] and cannot also hold one for [${requested.join(", ")}]. `
      + `One service, one grant: declare every table it touches in one place, because 035 turns this list into a Postgres role. `
      + `To obtain the existing handle from a second call site, call grant("${service}", []) with no tables.`,
  );
}
