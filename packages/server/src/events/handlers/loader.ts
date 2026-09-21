// Collects event handler modules from this directory (`src/events/handlers/`)
// and keys them by event type. This is the extension point tickets 010, 020
// and 027 build on: adding a handler means adding a file next to this one —
// nothing here or in ../ingest.ts needs an edit for a new handler to run.
//
// Contract: any file in this directory other than this one (and test files)
// must `export default` an object shaped like EventHandler below. A module
// that doesn't is logged and skipped, never thrown — a bad handler file must
// not take down ingest for every other event type.
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

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const selfFilename = path.basename(fileURLToPath(import.meta.url));

function isHandlerModuleFile(name: string): boolean {
  if (name === selfFilename) return false;
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
 * Loads every handler module in `dir` (default: this directory) and groups
 * them by `eventType`. Multiple handlers may register for the same type;
 * they run in filename order.
 */
export async function loadHandlers(dir: string = moduleDir): Promise<Map<string, EventHandler[]>> {
  const byType = new Map<string, EventHandler[]>();

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    // The directory not existing (e.g. a test pointed at a scratch dir that
    // was never created) is not ingest's problem to fail over.
    return byType;
  }

  const files = entries.filter(isHandlerModuleFile).sort();

  for (const file of files) {
    const href = pathToFileURL(path.join(dir, file)).href;
    let mod: { default?: unknown };
    try {
      mod = await import(href);
    } catch (error) {
      console.error(`event handler module ${file} failed to load; skipping`, error);
      continue;
    }
    if (!isEventHandler(mod.default)) {
      console.error(
        `event handler module ${file} does not default-export { eventType, handle }; skipping`,
      );
      continue;
    }
    const list = byType.get(mod.default.eventType) ?? [];
    list.push(mod.default);
    byType.set(mod.default.eventType, list);
  }

  return byType;
}
