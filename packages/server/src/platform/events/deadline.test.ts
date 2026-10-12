// Ticket 037.
//
// The test that matters is "a handler that never settles does not stall
// dispatch", and it is written against a promise that genuinely never
// resolves rather than a long timer — a long timer would pass with a broken
// implementation that merely waited.
import { afterEach, describe, expect, it, vi } from "vitest";
import { runWithDeadline, type HandlerOutcome } from "./deadline.ts";
import {
  handlerStats,
  overBudget,
  recentOutcomes,
  recordOutcome,
  resetSlowHandlers,
} from "./slow-handlers.ts";

/** A promise that never settles — the failure this ticket exists for. */
function hangs(): Promise<void> {
  return new Promise<void>(() => {
    // intentionally empty: nothing will ever resolve this
  });
}

function collector(): { outcomes: HandlerOutcome[]; onOutcome: (o: HandlerOutcome) => void } {
  const outcomes: HandlerOutcome[] = [];
  return { outcomes, onOutcome: (o) => outcomes.push(o) };
}

afterEach(() => {
  resetSlowHandlers();
});

describe("a handler that finishes inside its deadline", () => {
  it("resolves and reports ok", async () => {
    const { outcomes, onOutcome } = collector();
    await runWithDeadline(() => undefined, {
      label: "chat/handlers/reply.ts",
      eventType: "Stop",
      deadlineMs: 1000,
      onOutcome,
    });

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.state).toBe("ok");
  });

  it("rethrows what the handler throws, leaving ingest's own catch in charge", async () => {
    // The existing per-handler try/catch in ingest.ts is not replaced by
    // this — a thrown error is already handled there, and moving that
    // decision would change behaviour this ticket promised not to touch.
    const { outcomes, onOutcome } = collector();
    await expect(
      runWithDeadline(
        () => {
          throw new Error("handler blew up");
        },
        { label: "a.ts", eventType: "Stop", deadlineMs: 1000, onOutcome },
      ),
    ).rejects.toThrow("handler blew up");

    // Not reported as an outcome: it is not a deadline event.
    expect(outcomes).toEqual([]);
  });

  it("rethrows an async rejection inside the deadline", async () => {
    await expect(
      runWithDeadline(async () => {
        await Promise.resolve();
        throw new Error("async blew up");
      }, { label: "a.ts", eventType: "Stop", deadlineMs: 1000 }),
    ).rejects.toThrow("async blew up");
  });

  it("clears its timer, so a process can exit", async () => {
    // A deadline of an hour with no clearTimeout keeps the event loop alive
    // for an hour. In a suite that is a hang attributed to the wrong file.
    const cleared = vi.spyOn(globalThis, "clearTimeout");
    try {
      await runWithDeadline(() => undefined, {
        label: "a.ts",
        eventType: "Stop",
        deadlineMs: 3_600_000,
      });
      expect(cleared).toHaveBeenCalled();
    } finally {
      cleared.mockRestore();
    }
  });

  it("clears its timer even when the handler throws", async () => {
    const cleared = vi.spyOn(globalThis, "clearTimeout");
    try {
      await runWithDeadline(
        () => {
          throw new Error("boom");
        },
        { label: "a.ts", eventType: "Stop", deadlineMs: 3_600_000 },
      ).catch(() => undefined);
      expect(cleared).toHaveBeenCalled();
    } finally {
      cleared.mockRestore();
    }
  });
});

describe("a handler that hangs", () => {
  it("does not stall its caller", async () => {
    const started = Date.now();
    await runWithDeadline(hangs, { label: "slow.ts", eventType: "Stop", deadlineMs: 20 });
    const elapsed = Date.now() - started;

    // Resolved, not thrown, and quickly — the caller's next step is the next
    // handler.
    expect(elapsed).toBeLessThan(1000);
  });

  it("reports exceeded, naming the handler and the event type", async () => {
    const { outcomes, onOutcome } = collector();
    await runWithDeadline(hangs, {
      label: "locks/handlers/tool.ts",
      eventType: "PreToolUse",
      deadlineMs: 10,
      onOutcome,
    });

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      state: "exceeded",
      label: "locks/handlers/tool.ts",
      eventType: "PreToolUse",
      deadlineMs: 10,
    });
  });

  it("lets the handlers after it run — the point of the ticket", async () => {
    // Dispatch, in miniature: three handlers, the first of which hangs.
    const ran: string[] = [];
    const handlers: Array<[string, () => Promise<void> | void]> = [
      ["hangs.ts", hangs],
      ["second.ts", () => void ran.push("second")],
      ["third.ts", () => void ran.push("third")],
    ];

    for (const [label, work] of handlers) {
      await runWithDeadline(work, { label, eventType: "Stop", deadlineMs: 10 });
    }

    expect(ran).toEqual(["second", "third"]);
  });

  it("keeps a whole dispatch bounded by the deadline, not by the hang", async () => {
    const started = Date.now();
    for (const label of ["a.ts", "b.ts", "c.ts"]) {
      await runWithDeadline(hangs, { label, eventType: "Stop", deadlineMs: 15 });
    }
    const elapsed = Date.now() - started;

    // Three hung handlers at 15 ms each. Generous upper bound so this is not
    // a timing flake — what it rules out is "unbounded", which is what the
    // code did before.
    expect(elapsed).toBeLessThan(2000);
  });
});

describe("what an abandoned handler does afterwards", () => {
  it("records a late SUCCESS as having exceeded, not as having worked", async () => {
    // Without this, a handler that is permanently 10 ms too slow looks
    // healthy forever: it always finishes, so it never looks broken.
    const { outcomes, onOutcome } = collector();
    let release: () => void = () => undefined;
    const slow = (): Promise<void> =>
      new Promise<void>((resolve) => {
        release = resolve;
      });

    await runWithDeadline(slow, { label: "slow.ts", eventType: "Stop", deadlineMs: 10, onOutcome });
    expect(outcomes.map((o) => o.state)).toEqual(["exceeded"]);

    release();
    await vi.waitFor(() => expect(outcomes).toHaveLength(2));
    expect(outcomes[1]!.state).toBe("late-success");
  });

  it("catches a late THROW instead of letting it become an unhandled rejection", async () => {
    const { outcomes, onOutcome } = collector();
    let fail: (e: Error) => void = () => undefined;
    const work = (): Promise<void> =>
      new Promise<void>((_, reject) => {
        fail = reject;
      });

    await runWithDeadline(work, { label: "bad.ts", eventType: "Stop", deadlineMs: 10, onOutcome });
    fail(new Error("too late and broken"));

    await vi.waitFor(() => expect(outcomes).toHaveLength(2));
    expect(outcomes[1]).toMatchObject({ state: "late-failure", label: "bad.ts" });
    expect((outcomes[1] as { error: Error }).error.message).toBe("too late and broken");
  });

  it("survives a reporter that throws", async () => {
    // The reporter is supplied by a caller; a throwing one must not become
    // the failure it was reporting.
    await expect(
      runWithDeadline(hangs, {
        label: "a.ts",
        eventType: "Stop",
        deadlineMs: 10,
        onOutcome: () => {
          throw new Error("reporter is broken");
        },
      }),
    ).resolves.toBeUndefined();
  });
});

describe("slow-handlers", () => {
  it("counts a hung run once, not twice", async () => {
    // `exceeded` and the `late-success` that follows are the SAME run. Double
    // counting halves the apparent exceeded rate, which is the number an
    // operator would act on.
    let release: () => void = () => undefined;
    const slow = (): Promise<void> => new Promise<void>((resolve) => (release = resolve));

    await runWithDeadline(slow, {
      label: "slow.ts",
      eventType: "Stop",
      deadlineMs: 10,
      onOutcome: recordOutcome,
    });
    release();
    await vi.waitFor(() => expect(handlerStats()[0]!.lateSuccesses).toBe(1));

    const stats = handlerStats()[0]!;
    expect(stats.runs).toBe(1);
    expect(stats.exceeded).toBe(1);
    expect(stats.lateSuccesses).toBe(1);
  });

  it("separates a one-off from a repeat offender", async () => {
    for (let i = 0; i < 3; i += 1) {
      await runWithDeadline(hangs, {
        label: "always-hangs.ts",
        eventType: "Stop",
        deadlineMs: 5,
        onOutcome: recordOutcome,
      });
    }
    await runWithDeadline(hangs, {
      label: "once.ts",
      eventType: "Stop",
      deadlineMs: 5,
      onOutcome: recordOutcome,
    });
    await runWithDeadline(() => undefined, {
      label: "once.ts",
      eventType: "Stop",
      deadlineMs: 5,
      onOutcome: recordOutcome,
    });

    const [worst, ...rest] = handlerStats();
    expect(worst!.label).toBe("always-hangs.ts");
    expect(worst!.exceeded).toBe(3);
    expect(rest[0]!.exceeded).toBe(1);
    expect(rest[0]!.runs).toBe(2);
  });

  it("keys on handler AND event type, since one handler can serve several", () => {
    recordOutcome({
      state: "ok",
      label: "a.ts",
      eventType: "Stop",
      durationMs: 1,
      deadlineMs: 10,
    });
    recordOutcome({
      state: "ok",
      label: "a.ts",
      eventType: "SessionEnd",
      durationMs: 1,
      deadlineMs: 10,
    });
    expect(handlerStats()).toHaveLength(2);
  });

  it("bounds what it keeps", () => {
    for (let i = 0; i < 500; i += 1) {
      recordOutcome({
        state: "ok",
        label: `h${i}.ts`,
        eventType: "Stop",
        durationMs: 1,
        deadlineMs: 10,
      });
    }
    // An unbounded diagnostic buffer on the hot path is a memory leak with
    // good intentions, on a box where agent sessions are the RAM budget.
    expect(recentOutcomes().length).toBeLessThanOrEqual(200);
  });

  it("names handlers whose mean completed run eats the ingest budget", () => {
    recordOutcome({
      state: "ok",
      label: "heavy.ts",
      eventType: "Stop",
      durationMs: 80,
      deadlineMs: 2000,
    });
    recordOutcome({
      state: "ok",
      label: "light.ts",
      eventType: "Stop",
      durationMs: 2,
      deadlineMs: 2000,
    });

    expect(overBudget(50).map((s) => s.label)).toEqual(["heavy.ts"]);
  });

  it("does not divide by zero for a handler that has never completed", async () => {
    await runWithDeadline(hangs, {
      label: "never.ts",
      eventType: "Stop",
      deadlineMs: 5,
      onOutcome: recordOutcome,
    });
    expect(overBudget(50)).toEqual([]);
    expect(handlerStats()[0]!.completed).toBe(0);
  });
});
