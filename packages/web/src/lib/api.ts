// Typed fetch client for the event server.
//
// Every shape here is imported from `@office/shared`, never redeclared. A
// second copy of a server type is a copy that drifts, and the drift is
// silent: the UI keeps compiling against its own stale idea of a task while
// the server sends something else. `packages/web/tsconfig.json` typechecks
// against the same sources the server does, so an incompatible change to a
// shared type is a compile error here rather than a runtime surprise.
//
// HTTPS ONLY. The system-wide decision is https on every endpoint including
// loopback, and nothing in this file falls back to plaintext on failure — a
// silent downgrade is worse than a visible connection error. In dev the
// browser talks to Vite's proxy on the same origin, which forwards to the
// server's https listener (see vite.config.ts).
import type {
  TaskBoardColumn,
  TaskRecord,
  TaskState,
  TaskStateChange,
} from "@office/shared/tasks";
import type { TaskId } from "@office/shared/ids";

/** Same-origin by default: Vite proxies /api to the event server in dev, and
 * in production the app is served from the same origin as the API. */
const BASE = "/api";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });

  const text = await response.text();
  let body: unknown = null;
  if (text !== "") {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!response.ok) {
    // The server answers 400 with { error, problems[] } for caller
    // mistakes; surface the problems rather than a bare status, since the
    // whole point of validating in one place was to produce a readable list.
    const detail =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : response.statusText;
    throw new ApiError(response.status, body, `${response.status} ${detail}`);
  }

  return body as T;
}

// --- Events -------------------------------------------------------------------

/** Mirrors the server's StoredEventRow, via the same shape the socket
 * sends — see EventFrame in @office/shared/ws. */
export interface StoredEvent {
  readonly id: string;
  readonly projectId: string | null;
  readonly sessionId: string | null;
  readonly type: string;
  readonly payload: unknown;
  readonly receivedAt: string;
  readonly cursor: string;
}

/**
 * Events since a cursor. This is the backfill half of the live stream: on
 * reconnect the socket client asks for everything it missed, using the
 * cursor of the last event it applied.
 */
export function listEvents(params: {
  projectId?: string | null;
  since?: string | null;
  limit?: number;
}): Promise<StoredEvent[]> {
  const query = new URLSearchParams();
  if (params.projectId) query.set("project_id", params.projectId);
  if (params.since) query.set("since", params.since);
  if (params.limit) query.set("limit", String(params.limit));
  const suffix = query.toString();
  return request<StoredEvent[]>(`/events${suffix ? `?${suffix}` : ""}`);
}

// --- Board and tasks -------------------------------------------------------------

/** The board read model from ticket 013. Column and chip vocabulary comes
 * from @office/shared/tasks, so a new state cannot appear here without
 * appearing there. */
export interface BoardCard {
  readonly task: TaskRecord;
  /** The union, not a bare string: the column a card belongs in is decided
   * once by TASK_BOARD_COLUMN_OF, and typing it loosely here would let a
   * typo compile. */
  readonly column: TaskBoardColumn;
  readonly chip: TaskState;
}

export interface BoardColumn {
  readonly column: TaskBoardColumn;
  readonly cards: readonly BoardCard[];
  readonly earlierCount: number;
}

export interface Board {
  readonly columns: readonly BoardColumn[];
  readonly doneWindowDays: number;
}

export interface BoardFilters {
  readonly projectId?: string | null;
  readonly owner?: string | null;
  readonly department?: string | null;
  readonly state?: string | null;
}

export function getBoard(filters: BoardFilters = {}): Promise<Board> {
  const query = new URLSearchParams();
  if (filters.projectId) query.set("project_id", filters.projectId);
  if (filters.owner) query.set("owner", filters.owner);
  if (filters.department) query.set("department", filters.department);
  if (filters.state) query.set("state", filters.state);
  const suffix = query.toString();
  return request<Board>(`/board${suffix ? `?${suffix}` : ""}`);
}

export interface TaskWithHistory {
  readonly task: TaskRecord;
  readonly history: readonly TaskStateChange[];
}

export function getTask(id: TaskId | string): Promise<TaskWithHistory> {
  return request<TaskWithHistory>(`/tasks/${encodeURIComponent(id)}`);
}

export interface TaskPage {
  readonly tasks: readonly TaskRecord[];
  readonly nextCursor: string | null;
}

export function listTasks(params: BoardFilters & { limit?: number; cursor?: string | null } = {}):
  Promise<TaskPage> {
  const query = new URLSearchParams();
  if (params.projectId) query.set("project_id", params.projectId);
  if (params.owner) query.set("owner", params.owner);
  if (params.department) query.set("department", params.department);
  if (params.state) query.set("state", params.state);
  if (params.limit) query.set("limit", String(params.limit));
  if (params.cursor) query.set("cursor", params.cursor);
  const suffix = query.toString();
  return request<TaskPage>(`/tasks${suffix ? `?${suffix}` : ""}`);
}

export { request as apiRequest };
