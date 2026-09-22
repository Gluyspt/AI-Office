// Construction and validation, with no database anywhere in this file -
// that separation is the point of model.ts, and a test that needed a
// connection would quietly undo it.
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { asProjectId } from "@office/shared/ids";
import {
  TASK_TITLE_MAX_LENGTH,
  TaskValidationError,
  createTask,
  validateTask,
} from "./model.ts";

const projectId = asProjectId(randomUUID());

const valid = {
  projectId,
  title: "Wire the task board to the API",
  department: "dev" as const,
  owner: "gluy",
};

describe("createTask", () => {
  it("builds a task with a fresh id, in draft, with zeroed counters", () => {
    const task = createTask(valid);
    expect(task.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(task.state).toBe("draft");
    expect(task.tokenCost).toBe(0);
    expect(task.turnCount).toBe(0);
    expect(task.brief).toBe("");
    expect(task.model).toBeNull();
    expect(task.modelReason).toBeNull();
    expect(task.branch).toBeNull();
  });

  it("mints a different id each time", () => {
    expect(createTask(valid).id).not.toBe(createTask(valid).id);
  });

  it("offers no way to choose a starting state", () => {
    // Structural, not a runtime check: NewTask.state is the literal type
    // "draft" and NewTaskInput has no `state` field, so a caller cannot
    // propose one. Passing one anyway is ignored, not honoured.
    const task = createTask({ ...valid, state: "done" } as never);
    expect(task.state).toBe("draft");
  });

  it("trims title and owner, and keeps a brief that was written", () => {
    const task = createTask({ ...valid, title: "  spaced  ", owner: " gluy ", brief: " do the thing " });
    expect(task.title).toBe("spaced");
    expect(task.owner).toBe("gluy");
    expect(task.brief).toBe("do the thing");
  });

  it("treats an empty optional as absent rather than storing two spellings of unset", () => {
    const task = createTask({ ...valid, model: "   ", branch: "" });
    expect(task.model).toBeNull();
    expect(task.branch).toBeNull();
  });
});

describe("createTask - refusals", () => {
  it("reports every problem at once, not the first one", () => {
    let caught: unknown;
    try {
      createTask({ projectId: "not-a-uuid" as never, title: "", department: "management", owner: "" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TaskValidationError);
    const problems = (caught as TaskValidationError).problems;
    expect(problems).toHaveLength(4);
    expect(problems.join("\n")).toMatch(/projectId/);
    expect(problems.join("\n")).toMatch(/title is required/);
    expect(problems.join("\n")).toMatch(/department must be one of/);
    expect(problems.join("\n")).toMatch(/owner is required/);
  });

  it("refuses a department that is not one of the three", () => {
    // Management is above the departments and never owns tasks - see
    // TASK_DEPARTMENTS in @office/shared/tasks.
    expect(validateTask({ ...valid, department: "management" })).toEqual([
      expect.stringContaining("department must be one of dev, research, qa"),
    ]);
  });

  it("refuses a modelReason with no model to explain", () => {
    expect(validateTask({ ...valid, modelReason: "architecture work" })).toEqual([
      "modelReason was given without a model to explain",
    ]);
    expect(validateTask({ ...valid, model: "opus", modelReason: "architecture work" })).toEqual([]);
  });

  it("accepts any model string - any backend can serve any role", () => {
    for (const model of ["sonnet", "opus", "qwen-uni"]) {
      expect(validateTask({ ...valid, model })).toEqual([]);
    }
  });

  it("refuses a branch that is not the design's task/<id>-<slug> shape", () => {
    expect(validateTask({ ...valid, branch: "feature/whatever" })).toEqual([
      expect.stringContaining("branch must look like"),
    ]);
    expect(validateTask({ ...valid, branch: "main-dev" })).toHaveLength(1);
    expect(validateTask({ ...valid, branch: "task/0d1f-wire-the-board" })).toEqual([]);
  });

  it("caps the title so a pasted transcript cannot become one", () => {
    expect(validateTask({ ...valid, title: "x".repeat(TASK_TITLE_MAX_LENGTH) })).toEqual([]);
    expect(validateTask({ ...valid, title: "x".repeat(TASK_TITLE_MAX_LENGTH + 1) })).toEqual([
      expect.stringContaining("at most 200 characters"),
    ]);
  });
});

describe("validateTask", () => {
  it("returns an empty list for a task createTask would accept", () => {
    expect(validateTask(valid)).toEqual([]);
  });
});
