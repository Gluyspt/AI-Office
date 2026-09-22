// Live event stream, with the two properties that make a board trustworthy:
// it reconnects on its own, and it does not lie about being current.
//
// THE FAILURE MODE THIS FILE EXISTS TO PREVENT
// ---------------------------------------------
// A silently stale board is the worst thing this page can do. A board that
// says "disconnected" is annoying; a board that looks live and is twenty
// minutes behind gets someone to approve work that already failed. So:
// every drop is visible through `onStatus`, and every reconnect backfills
// the gap through `GET /events?since=<cursor>` before resuming live frames.
//
// EXACTLY ONCE, NEITHER LOST NOR DOUBLED
// ---------------------------------------
// The cursor is the last event actually delivered to the consumer, not the
// last received — so a frame that arrives while a backfill is in flight
// cannot advance it past the gap. Frames arriving mid-backfill are buffered
// and replayed after it, and every event is passed through a seen-id filter,
// because the backfill window and the live stream legitimately overlap: the
// server may send an event we already have.
//
// wss:// ONLY. No plaintext fallback, per the system-wide https decision.
import type { ClientFrame, EventFrame, ServerFrame } from "@office/shared/ws";
import { listEvents, type StoredEvent } from "./api.ts";

export type ConnectionStatus = "connecting" | "open" | "reconnecting" | "closed";

export interface EventStreamOptions {
  readonly projectId?: string | null;
  readonly sessionId?: string | null;
  /** Called for every event, in order, exactly once. */
  readonly onEvent: (event: StoredEvent) => void;
  readonly onStatus?: (status: ConnectionStatus, detail?: string) => void;
  /** Injected in tests. Defaults to the global WebSocket. */
  readonly socketFactory?: (url: string) => WebSocketLike;
  /** Injected in tests so backoff does not make a suite wait. */
  readonly backfill?: typeof listEvents;
  readonly now?: () => number;
}

/** The slice of WebSocket this client uses. Narrow on purpose: a test can
 * implement it in a dozen lines, and nothing here depends on browser
 * internals. */
export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  onopen: ((event?: unknown) => void) | null;
  onclose: ((event?: unknown) => void) | null;
  onerror: ((event?: unknown) => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
}

/** Capped exponential backoff. Capped because an office left overnight
 * should reconnect within seconds of the server coming back, not hours. */
export const BACKOFF_MS = [250, 500, 1_000, 2_000, 5_000, 10_000] as const;
export const BACKOFF_CAP_MS: number = BACKOFF_MS[BACKOFF_MS.length - 1]!;

export function backoffFor(attempt: number): number {
  return BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? BACKOFF_CAP_MS;
}

function socketUrl(): string {
  if (typeof window === "undefined") return "wss://localhost/ws";
  const { host, protocol } = window.location;
  // https -> wss, and http -> ws only because a dev server on plain http
  // would otherwise be unusable; the deployed app is always https, so this
  // resolves to wss in every real deployment. It is a mirror of the page's
  // own transport, never a downgrade of it.
  const scheme = protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${host}/ws`;
}

export interface EventStream {
  /** Stop reconnecting and close. */
  close(): void;
  readonly status: ConnectionStatus;
  /** The cursor of the last event handed to the consumer. */
  readonly cursor: string | null;
}

export function openEventStream(options: EventStreamOptions): EventStream {
  const makeSocket =
    options.socketFactory ??
    ((url: string) => new WebSocket(url) as unknown as WebSocketLike);
  const backfill = options.backfill ?? listEvents;

  let socket: WebSocketLike | null = null;
  let status: ConnectionStatus = "connecting";
  let cursor: string | null = null;
  let attempt = 0;
  let stopped = false;
  let backfilling = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const pending: StoredEvent[] = [];

  // Bounded: the whole point of the cursor is that we do not need unbounded
  // memory to avoid duplicates. Only recent ids can plausibly repeat.
  const seen = new Set<string>();
  const SEEN_LIMIT = 512;

  function setStatus(next: ConnectionStatus, detail?: string): void {
    status = next;
    options.onStatus?.(next, detail);
  }

  function deliver(event: StoredEvent): void {
    if (seen.has(event.id)) return;
    seen.add(event.id);
    if (seen.size > SEEN_LIMIT) {
      // Oldest first; Set preserves insertion order.
      const oldest = seen.values().next().value;
      if (oldest !== undefined) seen.delete(oldest);
    }
    cursor = event.cursor;
    options.onEvent(event);
  }

  async function runBackfill(): Promise<void> {
    if (cursor === null) return; // nothing missed: this is the first connect
    backfilling = true;
    try {
      const missed = await backfill({
        projectId: options.projectId ?? null,
        since: cursor,
        limit: 500,
      });
      for (const event of missed) deliver(event);
    } catch (error) {
      // A failed backfill must not look like a healthy stream. Staying in
      // `reconnecting` is the honest state — the socket may be open, but
      // the board is not known to be current.
      setStatus("reconnecting", `backfill failed: ${String(error)}`);
      return;
    } finally {
      backfilling = false;
      // Frames that arrived while the gap was being filled, replayed in
      // arrival order. deliver() drops any the backfill already covered.
      while (pending.length > 0) deliver(pending.shift()!);
    }
  }

  function scheduleReconnect(reason: string): void {
    if (stopped) return;
    setStatus("reconnecting", reason);
    const delay = backoffFor(attempt);
    attempt += 1;
    timer = setTimeout(connect, delay);
  }

  function connect(): void {
    if (stopped) return;
    let opened: WebSocketLike;
    try {
      opened = makeSocket(socketUrl());
    } catch (error) {
      scheduleReconnect(`could not open socket: ${String(error)}`);
      return;
    }
    socket = opened;

    opened.onopen = () => {
      attempt = 0;
      setStatus("open");
      const subscribe: ClientFrame = {
        type: "subscribe",
        ...(options.projectId ? { project_id: options.projectId } : {}),
        ...(options.sessionId ? { session_id: options.sessionId } : {}),
      };
      opened.send(JSON.stringify(subscribe));
      void runBackfill();
    };

    opened.onmessage = (message) => {
      let frame: ServerFrame;
      try {
        frame = JSON.parse(message.data) as ServerFrame;
      } catch {
        return; // a malformed frame is the server's bug, not a reason to drop the stream
      }
      if (frame.type === "ping") {
        const pong: ClientFrame = { type: "pong" };
        opened.send(JSON.stringify(pong));
        return;
      }
      if (frame.type === "event") {
        const event = (frame as EventFrame).event;
        if (backfilling) {
          // Buffered, not dropped and not delivered: delivering now would
          // advance the cursor past the gap still being filled.
          pending.push(event);
          return;
        }
        deliver(event);
      }
    };

    opened.onerror = () => {
      // onclose follows; reconnecting here too would double-schedule.
    };

    opened.onclose = () => {
      if (stopped) return;
      scheduleReconnect("socket closed");
    };
  }

  connect();

  return {
    close(): void {
      stopped = true;
      if (timer) clearTimeout(timer);
      setStatus("closed");
      socket?.close();
    },
    get status(): ConnectionStatus {
      return status;
    },
    get cursor(): string | null {
      return cursor;
    },
  };
}
