// A deadline around one event handler.
//
// Ticket 037. This closes the one failure in the event path that nothing
// else catches. Already handled, and needing no work here: a bus subscriber
// that throws is isolated (`bus.ts:68-75`), a handler module that fails to
// load is logged and skipped (`handler-loader.ts`), and a handler whose
// `handle()` throws is caught per handler (`ingest.ts:209-212`).
//
// What none of those see is a handler that HANGS. Dispatch is a sequential
// `for (const handler of handlers) { await handler.handle(...) }`, so one
// handler that never settles stalls every handler behind it and the ingest
// POST itself — and ingest is what a blocking hook waits on. A `try/catch`
// cannot observe a promise that simply never resolves.
//
// IT ABANDONS, IT DOES NOT CANCEL. Node cannot cancel an in-flight `await`,
// and `EventHandler` takes no `AbortSignal` today. So expiry means dispatch
// stops *waiting*; the handler may still be running, may still finish, and
// may still throw. All three are reported rather than hidden. Calling this
// "cancel" would be a lie in the signature, and the honest fix — handing
// handlers a signal so one holding a transaction can roll back rather than
// committing work nobody is waiting for — changes every handler file and is
// its own ticket. See the open question on 037.
//
// WHY THE REPORTER IS INJECTED rather than imported. This file is platform,
// and platform may import nothing from `features/` — so it cannot reach
// `features/events/ingest.ts` to record an event. That constraint produced a
// better shape than the ticket described: the mechanism is pure and
// testable, and the caller that already owns event emission supplies the
// reporter. The boundary rule earned its keep here.

/** What happened to one handler run. */
export type HandlerOutcome =
  | {
      readonly state: "ok";
      readonly label: string;
      readonly eventType: string;
      readonly durationMs: number;
      readonly deadlineMs: number;
    }
  | {
      readonly state: "exceeded";
      readonly label: string;
      readonly eventType: string;
      readonly deadlineMs: number;
    }
  | {
      /** It finished, but after dispatch had already moved on. */
      readonly state: "late-success";
      readonly label: string;
      readonly eventType: string;
      readonly durationMs: number;
      readonly deadlineMs: number;
    }
  | {
      /** It threw, after dispatch had already moved on. */
      readonly state: "late-failure";
      readonly label: string;
      readonly eventType: string;
      readonly durationMs: number;
      readonly deadlineMs: number;
      readonly error: unknown;
    };

export interface DeadlineOptions {
  /** The handler's file, as `handler-loader.ts` names it — what a reader
   *  needs in order to go and look. */
  readonly label: string;
  readonly eventType: string;
  readonly deadlineMs: number;
  /** Called for every outcome, including `ok`. Must not throw; it is called
   *  from a path that has already decided what it is doing. */
  readonly onOutcome?: (outcome: HandlerOutcome) => void;
}

function report(options: DeadlineOptions, outcome: HandlerOutcome): void {
  if (options.onOutcome === undefined) return;
  try {
    options.onOutcome(outcome);
  } catch {
    // A reporter that throws must not become the failure it was reporting.
    // Deliberately silent: the alternative is recursing into the same path.
  }
}

/**
 * Runs `work` and stops waiting after `deadlineMs`.
 *
 * Resolves when the work finishes inside the deadline, and **rethrows** what
 * it throws inside the deadline — error handling for the normal case stays
 * where it already is, in `ingest.ts`'s per-handler `try/catch`. Resolves
 * (does not throw) when the deadline passes, because the caller's next step
 * is to carry on to the next handler, which is the whole point.
 */
export async function runWithDeadline(
  work: () => Promise<void> | void,
  options: DeadlineOptions,
): Promise<void> {
  const started = Date.now();

  // Promise.resolve().then(work) so a handler that throws SYNCHRONOUSLY is
  // captured as a rejection rather than escaping past the race.
  const running = Promise.resolve().then(work);

  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<"expired">((resolve) => {
    timer = setTimeout(() => resolve("expired"), options.deadlineMs);
  });

  let outcome: "finished" | "expired";
  try {
    outcome = await Promise.race([running.then(() => "finished" as const), expiry]);
  } catch (error) {
    // Threw inside the deadline. Clear the timer or the process holds it for
    // the rest of the deadline, which in a test suite is a hang nobody
    // attributes to the right place.
    clearTimeout(timer);
    throw error;
  }

  if (outcome === "finished") {
    clearTimeout(timer);
    report(options, {
      state: "ok",
      label: options.label,
      eventType: options.eventType,
      durationMs: Date.now() - started,
      deadlineMs: options.deadlineMs,
    });
    return;
  }

  report(options, {
    state: "exceeded",
    label: options.label,
    eventType: options.eventType,
    deadlineMs: options.deadlineMs,
  });

  // The handler is still running. Attaching these two does three jobs: it
  // keeps a later rejection from becoming an unhandled rejection that crashes
  // the process, it attributes the failure to the handler that caused it, and
  // it records a LATE SUCCESS as having exceeded rather than as having worked
  // — without which a handler that is permanently a little too slow looks
  // healthy forever.
  running.then(
    () => {
      report(options, {
        state: "late-success",
        label: options.label,
        eventType: options.eventType,
        durationMs: Date.now() - started,
        deadlineMs: options.deadlineMs,
      });
    },
    (error: unknown) => {
      report(options, {
        state: "late-failure",
        label: options.label,
        eventType: options.eventType,
        durationMs: Date.now() - started,
        deadlineMs: options.deadlineMs,
        error,
      });
    },
  );
}
