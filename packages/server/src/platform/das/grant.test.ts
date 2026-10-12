// Ticket 034. The grant rules, as a table — no database, no pool.
import { describe, expect, it } from "vitest";
import { GrantError } from "./contract.ts";
import { assertCompatibleGrant, normaliseTables, validateServiceName } from "./grant.ts";

describe("validateServiceName", () => {
  it("accepts the names the services actually use", () => {
    for (const name of ["tasks", "locks", "chat", "control", "realtime", "planning", "permissions"]) {
      expect(() => validateServiceName(name)).not.toThrow();
    }
  });

  it("accepts underscores, which the MCP server names already settled on", () => {
    expect(() => validateServiceName("office_tasks")).not.toThrow();
  });

  it.each([
    ["", "empty"],
    ["   ", "blank"],
    ["Tasks", "capitalised — it becomes a Postgres role"],
    ["my-service", "hyphenated, so it would need quoting in SQL"],
    ["9lives", "leading digit"],
    ["drop table", "a space"],
    ['tasks"', "a quote character"],
  ])("refuses %j (%s)", (name) => {
    expect(() => validateServiceName(name)).toThrow(GrantError);
  });

  it("explains itself by naming the role 035 would create", () => {
    // The message has to say why a hyphen is a problem, or the next person
    // just tries a different separator.
    expect(() => validateServiceName("my-service")).toThrow(/my-service_svc|SET LOCAL ROLE/);
  });
});

describe("normaliseTables", () => {
  it("sorts, so two declarations of the same set compare equal", () => {
    expect(normaliseTables("tasks", ["task_dependencies", "tasks"])).toEqual([
      "task_dependencies",
      "tasks",
    ]);
    expect(normaliseTables("tasks", ["tasks", "task_dependencies"])).toEqual([
      "task_dependencies",
      "tasks",
    ]);
  });

  it("de-duplicates", () => {
    expect(normaliseTables("tasks", ["tasks", "tasks"])).toEqual(["tasks"]);
  });

  it("trims", () => {
    expect(normaliseTables("tasks", ["  tasks  "])).toEqual(["tasks"]);
  });

  it("accepts a schema-qualified name", () => {
    expect(normaliseTables("tasks", ["public.tasks"])).toEqual(["public.tasks"]);
  });

  it("accepts an empty list — that is how a second call site asks for the handle", () => {
    expect(normaliseTables("tasks", [])).toEqual([]);
  });

  it.each([
    ["Tasks", "capitalised"],
    ["task-deps", "hyphenated"],
    ["a.b.c", "two dots"],
    ["tasks; drop table x", "a statement"],
    ["", "empty"],
  ])("refuses %j (%s)", (table) => {
    expect(() => normaliseTables("tasks", [table])).toThrow(GrantError);
  });

  it("names the offending table and says where it would break", () => {
    // These become GRANT statements in a generated migration, so the failure
    // without this check is at apply time, not declaration time.
    expect(() => normaliseTables("tasks", ["task-deps"])).toThrow(/task-deps/);
    expect(() => normaliseTables("tasks", ["task-deps"])).toThrow(/GRANT|migration/);
  });
});

describe("assertCompatibleGrant", () => {
  it("passes when the second declaration matches the first", () => {
    expect(() => assertCompatibleGrant("tasks", ["tasks"], ["tasks"])).not.toThrow();
  });

  it("passes when the second call declares nothing — asking for the existing handle", () => {
    expect(() => assertCompatibleGrant("tasks", ["tasks"], [])).not.toThrow();
  });

  it("refuses a second, different declaration rather than merging the two", () => {
    // Merging would make a service's real table list the union of whatever
    // happened to be imported — stated in no single file, checkable by no
    // reviewer.
    expect(() => assertCompatibleGrant("tasks", ["tasks"], ["file_locks"])).toThrow(GrantError);
  });

  it("tells the caller how to get the handle without restating the declaration", () => {
    expect(() => assertCompatibleGrant("tasks", ["tasks"], ["file_locks"])).toThrow(
      /grant\("tasks", \[\]\)/,
    );
  });

  it("names both sets, so the conflict is diagnosable from the message alone", () => {
    expect(() => assertCompatibleGrant("tasks", ["tasks"], ["file_locks"])).toThrow(/tasks/);
    expect(() => assertCompatibleGrant("tasks", ["tasks"], ["file_locks"])).toThrow(/file_locks/);
  });
});
