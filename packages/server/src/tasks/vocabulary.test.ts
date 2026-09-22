// The task vocabulary in packages/shared/src/tasks.ts, checked against the
// design rather than against itself. The literal strings below are
// transcribed from docs/ai-agent-office-design.md - the lifecycle diagram's
// node labels and the Tasks-page row's chip list - so a rename that quietly
// drifts from the design fails here.
//
// Why this test lives in the server package and not next to the module it
// tests: packages/shared/tsconfig.json does not set
// allowImportingTsExtensions (it is ticket 001's file, not this ticket's),
// so a relative `./tasks.ts` *value* import inside that package does not
// typecheck. Importing through the package's exports map from here does,
// and exercises the same public entry point every consumer uses.
import { describe, expect, it } from "vitest";
import {
  TASK_ACTOR_KINDS,
  TASK_BOARD_COLUMN_OF,
  TASK_DEPARTMENTS,
  TASK_STATES,
  TASK_STATE_LABELS,
  asTaskState,
  isTaskActorKind,
  isTaskDepartment,
  isTaskState,
} from "@office/shared/tasks";

/** The lifecycle diagram's ten nodes, in the design's own words. */
const DESIGN_STATE_LABELS = [
  "draft",
  "pending",
  "in progress",
  "paused",
  "ready for QA",
  "CI",
  "QA review",
  // The diagram says "lead approval"; the Tasks-page chip list says
  // "awaiting lead". Ticket 012's open question assumed one state, two
  // labels: the diagram's wording names it, the UI table's wording is what
  // the chip shows. Both spellings are asserted below.
  "awaiting lead",
  "delivered",
  "done",
];

describe("the state union", () => {
  it("is exactly the design's ten states, in lifecycle order", () => {
    expect([...TASK_STATES]).toEqual([
      "draft",
      "pending",
      "in_progress",
      "paused",
      "ready_for_qa",
      "ci",
      "qa_review",
      "lead_approval",
      "delivered",
      "done",
    ]);
    expect(TASK_STATES).toHaveLength(10);
    expect(new Set(TASK_STATES).size).toBe(10);
  });

  it("carries the design's own wording as display text", () => {
    expect(TASK_STATES.map((state) => TASK_STATE_LABELS[state])).toEqual(DESIGN_STATE_LABELS);
  });

  it("labels lead_approval with the UI table's wording, not the diagram's", () => {
    // Recorded explicitly because it is an assumption, not a fact: if the
    // two labels turn out to be two states, this is the test that changes.
    expect(TASK_STATE_LABELS.lead_approval).toBe("awaiting lead");
  });

  it("narrows strings, and refuses anything else", () => {
    expect(isTaskState("ready_for_qa")).toBe(true);
    expect(isTaskState("ready for QA")).toBe(false);
    // "needs attention" is named in the design's circuit-breaker paragraph
    // but is not one of the ten lifecycle states. Step 7 owns it; this
    // ticket does not invent an eleventh state for it.
    expect(isTaskState("needs_attention")).toBe(false);
    expect(isTaskState(undefined)).toBe(false);
    expect(asTaskState("ci")).toBe("ci");
    expect(() => asTaskState("nope")).toThrow(TypeError);
  });
});

describe("board columns", () => {
  it("places every state in one of the design's four columns", () => {
    for (const state of TASK_STATES) {
      expect(TASK_BOARD_COLUMN_OF[state]).toBeDefined();
    }
    expect(TASK_BOARD_COLUMN_OF.draft).toBe("draft");
    expect(TASK_BOARD_COLUMN_OF.pending).toBe("todo");
    expect(TASK_BOARD_COLUMN_OF.done).toBe("done");
  });

  it("puts every pipeline chip the design lists inside the In progress column", () => {
    // "Pipeline states appear as chips inside In progress (in progress,
    // paused, ready for QA, CI, QA review, awaiting lead)."
    const chips = [
      "in_progress",
      "paused",
      "ready_for_qa",
      "ci",
      "qa_review",
      "lead_approval",
    ] as const;
    for (const state of chips) {
      expect(TASK_BOARD_COLUMN_OF[state]).toBe("in_progress");
    }
  });
});

describe("departments and actors", () => {
  it("has the three departments a task can belong to, and not Management", () => {
    expect([...TASK_DEPARTMENTS]).toEqual(["dev", "research", "qa"]);
    expect(isTaskDepartment("management")).toBe(false);
    expect(isTaskDepartment("dev")).toBe(true);
  });

  it("records who acted as one of human, agent or system", () => {
    expect([...TASK_ACTOR_KINDS]).toEqual(["human", "agent", "system"]);
    expect(isTaskActorKind("system")).toBe(true);
    expect(isTaskActorKind("robot")).toBe(false);
  });
});
