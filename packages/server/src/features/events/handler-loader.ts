// Collects event handler modules from every `src/features/*/handlers/`
// directory and keys them by event type. This is the extension point
// tickets 010, 020 and 027 build on: adding a handler means adding a file
// under the handlers/ directory of the feature it belongs to — nothing
// here or in ./ingest.ts needs an edit for a new handler to run.
//
// Handlers live with their feature rather than in one shared directory
// because they belong to different features: 010's reply handler is chat,
// 020's tool handler is locks, 027's permission handler is permissions.
// Each is still its own file, so the one-file-one-ticket rule holds.
//
// Contract: any non-test file in a feature's handlers/ directory must
// `export default` an object shaped like EventHandler below. A module that
// doesn't is logged and skipped, never thrown — a bad handler file must not
// take down ingest for every other event type.
//
// No caching: the directory is re-scanned on every call. Node's ESM loader
// already caches a module by resolved URL, so re-importing an
// already-loaded handler file is a cache hit, not a re-execution — the cost
// actually paid per call is one readdir plus a cache-hit import per known
// handler file, which is well under this ticket's 50ms p95 ingest budget
// for the handful of handler files any real deployment will have. Simplicity
// here also means the "add a file, no edit needed" acceptance criterion
// holds with no extra test-only reset hook.
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** What a handler receives — the row ingest.ts persisted, already parsed. */
export interface HandledEvent {
  readonly id: string;
  readonly type: string;
  readonly sessionId: string | null;
  readonly projectId: string | null;
  readonly payload: unknown;
  readonly receivedAt: Date;
}

export interface EventHandler {
  /** Matches an event's `type` (== the payload's hook_event_name, or a
   *  synthetic system type like "TlsHandshakeRejected"). */
  readonly eventType: string;
  handle(event: HandledEvent): Promise<void> | void;
}

// src/features/events/ -> src/features/
const featuresDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function isHandlerModuleFile(name: string): boolean {
  if (!name.endsWith(".ts") && !name.endsWith(".js")) return false;
  if (name.endsWith(".test.ts") || name.endsWith(".test.js")) return false;
  if (name.endsWith(".d.ts")) return false;
  return true;
}

function isEventHandler(candidate: unknown): candidate is EventHandler {
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    typeof (candidate as EventHandler).eventType === "string" &&
    (candidate as EventHandler).eventType.length > 0 &&
    typeof (candidate as EventHandler).handle === "function"
  );
}

/**
 * Loads every handler module under `dir`/&#42;/handlers/ (default: the features
 * tree) and groups them by `eventType`. Multiple handlers may register for
 * the same type; they run in feature-name then filename order.
 */
export async function loadHandlers(
  dir: string = featuresDir,
): Promise<Map<string, EventHandler[]>> {
  const byType = new Map<string, EventHandler[]>();

  let features: string[];
  try {
    features = await readdir(dir);
  } catch {
    // The directory not existing (e.g. a test pointed at a scratch dir that
    // was never created) is not ingest's problem to fail over.
    return byType;
  }

  // One readdir per feature, issued together rather than in sequence. This
  // runs on every ingest (see the no-caching note above), and ingest is the
  // hot path — when the flat src/events/handlers/ directory became one
  // directory per feature, doing these serially turned a single readdir into
  // N awaited round trips and measurably widened the window in which a
  // concurrently-written event could land between an insert and its
  // read-back. Order is restored below, so registration stays deterministic.
  const listings = await Promise.all(
    [...features].sort().map(async (feature) => {
      const handlersDir = path.join(dir, feature, "handlers");
      try {
        return { feature, handlersDir, entries: await readdir(handlersDir) };
      } catch {
        // A feature with no handlers/ directory is the common case.
        return { feature, handlersDir, entries: [] as string[] };
      }
    }),
  );

  for (const { feature, handlersDir, entries } of listings) {
    for (const file of entries.filter(isHandlerModuleFile).sort()) {
      const rel = path.join(feature, "handlers", file);
      const href = pathToFileURL(path.join(handlersDir, file)).href;
      let mod: { default?: unknown };
      try {
        mod = await import(href);
      } catch (error) {
        console.error(`event handler module ${rel} failed to load; skipping`, error);
        continue;
      }
      if (!isEventHandler(mod.default)) {
        console.error(
          `event handler module ${rel} does not default-export { eventType, handle }; skipping`,
        );
        continue;
      }
      const list = byType.get(mod.default.eventType) ?? [];
      list.push(mod.default);
      byType.set(mod.default.eventType, list);
    }
  }

  return byType;
}
