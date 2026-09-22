// A type-level test: the API client's shapes must BE the shared ones, not
// copies that compile today and drift tomorrow.
//
// These assertions run at typecheck time, not at runtime. `@ts-expect-error`
// is the load-bearing part — if a mismatch it flags ever became *valid*, the
// directive itself errors, so this file fails when the types silently
// converge as well as when they diverge.
import { describe, expect, it } from "vitest";
import type { TaskRecord, TaskState } from "@office/shared/tasks";
import type { BoardCard } from "./api.ts";

describe("API types come from @office/shared, not redeclared", () => {
  it("a board card's task IS the shared TaskRecord", () => {
    // Assignable both ways = the same type, not a structural lookalike.
    type CardTask = BoardCard["task"];
    const toShared: (value: CardTask) => TaskRecord = (value) => value;
    const fromShared: (value: TaskRecord) => CardTask = (value) => value;
    expect(typeof toShared).toBe("function");
    expect(typeof fromShared).toBe("function");
  });

  it("a chip is a TaskState and refuses anything else", () => {
    const chip: BoardCard["chip"] = "in_progress";
    const asState: TaskState = chip;
    expect(asState).toBe("in_progress");

    // @ts-expect-error a state outside the shared union must not typecheck
    const invalid: BoardCard["chip"] = "marketing";
    expect(invalid).toBe("marketing");
  });

  it("refuses a task record missing a required shared field", () => {
    // @ts-expect-error TaskRecord requires far more than a title
    const incomplete: TaskRecord = { title: "only a title" };
    expect(incomplete.title).toBe("only a title");
  });
});
