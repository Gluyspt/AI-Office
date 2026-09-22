// The app shell: nav, status strip, page outlet, overlay host.
//
// Nothing here knows which pages or overlays exist. Nav links are plain
// hrefs to `/tasks` and `/control`, so those pages can land in tickets 025
// and 029 without this file changing; overlays are collected by glob; and
// health conditions are records, so 020's degraded banner raises one rather
// than being special-cased here.
//
// The one live wire the shell owns is the event socket, because the
// disconnected state is a property of the whole page rather than of any one
// panel. A silently stale board is the worst failure this app has, so the
// socket's status is surfaced as a condition the moment it drops.
import { useEffect, type ReactNode } from "react";
import { OverlayHost } from "../lib/overlays.tsx";
import {
  SOCKET_CONDITION_KEY,
  SystemStatus,
  useHealthConditions,
} from "../lib/SystemStatus.tsx";
import { openEventStream } from "../lib/ws.ts";

/** Dev-mode identity. There is NO authentication until step 9 — the design
 * requires app-level login because "every message, approval, and acceptance
 * is attributed", and this is a placeholder that attributes everything to
 * one name. Wrong, but visibly wrong: it is rendered in the header rather
 * than hidden, so nobody mistakes this for a logged-in app.
 *
 * DO NOT EXPOSE THIS APP BEYOND LOCALHOST OR A TRUSTED NETWORK. */
const DEV_IDENTITY = import.meta.env?.VITE_DEV_IDENTITY ?? "dev";

export default function Root({
  children,
  pathname = "/",
}: {
  readonly children: ReactNode;
  readonly pathname?: string;
}): React.ReactElement {
  const health = useHealthConditions();
  const { raise, clear } = health;

  useEffect(() => {
    const stream = openEventStream({
      onEvent: () => {
        // The shell does not interpret events — pages subscribe to what
        // they need. This connection exists so the *connection state* is
        // known page-wide.
      },
      onStatus: (status, detail) => {
        if (status === "open") {
          clear(SOCKET_CONDITION_KEY);
          return;
        }
        if (status === "closed") return;
        raise({
          key: SOCKET_CONDITION_KEY,
          severity: status === "reconnecting" ? "error" : "warning",
          message:
            status === "reconnecting"
              ? "Disconnected — this page may be out of date"
              : "Connecting…",
          detail,
        });
      },
    });
    return () => stream.close();
  }, [raise, clear]);

  return (
    <div className="app">
      <header className="app__header">
        <a className="app__brand" href="/">
          AI Agent Office
        </a>
        <nav className="app__nav">
          {/* Plain hrefs on purpose: these pages arrive in later tickets,
              and this file must not change when they do. */}
          <a href="/tasks" aria-current={pathname.startsWith("/tasks") ? "page" : undefined}>
            Tasks
          </a>
          <a href="/control" aria-current={pathname.startsWith("/control") ? "page" : undefined}>
            Control
          </a>
        </nav>
        <span className="app__identity" title="No authentication until step 9">
          {DEV_IDENTITY}
        </span>
      </header>

      <SystemStatus conditions={health.conditions} />

      <main className="app__main">{children}</main>

      <OverlayHost />
    </div>
  );
}
