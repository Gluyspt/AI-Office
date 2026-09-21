---
id: "010"
title: Stop-hook reply correlation and chat transcript store
build_step: 1
department: dev
estimated_model: opus
blocked_by: ["002", "005", "008"]
---

# 010 — Stop-hook reply correlation and chat transcript store

**Build step:** 1 — Spine
**Department:** dev
**Estimated model:** opus — the correlation problem is the risky part of the spine, and the design flags it as such.
**Blocked by:** 002, 005, 008

## Why

"Steps 1–3 carry the risk. If the chat bridge doesn't work, nothing above it matters." This ticket is
the chat bridge: an agent's reply leaves through the Stop hook, arrives at the event server, gets tied
to the session a human is watching, and lands in a transcript the chat panel can render and backfill
from.

The design is explicit that the transcript file must not be read for the current turn, because it is
written asynchronously and may lag. `last_assistant_message` is the source.

## Scope

### Files created

- `packages/server/src/events/handlers/reply.ts` — Stop handler: correlate to a session row, extract `last_assistant_message`, append to the conversation, publish on the bus
- `packages/server/src/chat/transcript.ts` — append and read, ordered, with paging
- `packages/server/src/chat/conversations.ts` — resolve or create the conversation for a session, and open a new segment when a session replaces another
- `packages/server/src/routes/chat.ts` — `GET /conversations/:id/messages`, `GET /sessions/:id/conversation`, and `POST /conversations/:id/messages` which records the outbound human message then calls ticket 008's `messageSession`
- `packages/shared/src/chat.ts` — conversation, segment and message records: direction, author, body, turn id, timestamp
- `db/migrations/0004_conversations.sql` — `conversations` (keyed by task **or** role slot), `conversation_segments` (one per session, with its restart reason and whether a handoff was restored), and `chat_messages` carrying both `conversation_id` and `session_id`

### Files modified

None.

## Decided

**A conversation belongs to a task or to a role slot; sessions are segments within it.** Role slots (project + department + role) are first-class, not a fallback — Management and department leads never have tasks. Every message carries both `conversation_id` and `session_id`, so a human sees continuous history across pause, resume, model switch and crash, while the record of which process produced each message stays intact.

## Acceptance criteria

- [ ] A conversation resolves by task id where the session has a task, and by role slot (project, department, role) where it does not — asserted for a Management lead, a dev lead, and a task agent.
- [ ] A session replacing another on the same task or role slot appends a **new segment to the existing conversation**, never a new conversation. Asserted across a pause/resume cycle.
- [ ] Each segment records why the previous one ended — paused, model switch, crash, completed — and whether context was restored from a handoff.
- [ ] A Stop event for a known session appends exactly one inbound message carrying `last_assistant_message` verbatim, attributed to the right conversation and segment.
- [ ] A Stop event that cannot be correlated to a session row is stored as orphaned with its payload intact, and logged — never dropped, never crashed on.
- [ ] Outbound messages are recorded **before** delivery, with the human author attached, so a message that fails to deliver is still visible in the transcript with a failed marker.
- [ ] Ordering is stable under concurrency: 50 interleaved inbound and outbound writes read back in send order, asserted by test.
- [ ] `GET /conversations/:id/messages?before=` pages backwards across segment boundaries without gaps or duplicates.
- [ ] Every appended message publishes on the WebSocket bus, and a client subscribed to that session receives it — the end-to-end assertion that the chat bridge works.
- [ ] Nothing in this ticket reads a Claude transcript file.
- [ ] A turn that ends with no assistant text (tool call only, or an interrupted turn) does not append an empty message.
- [ ] Two sessions belonging to different users never cross-contaminate transcripts, asserted with concurrent traffic from both.

## Open questions

- [ ] The correlation key depends entirely on ticket 002's finding. If no payload field ties a hook to our session, the fallback is an env var injected at launch and echoed by the hook — that changes ticket 009's provisioning too. Do not start this ticket before 002 reports.
- [ ] How much history the chat panel loads on open is still undecided; the API pages, so this is ticket 026's call.
- [ ] Whether multiple humans messaging one agent need per-author threading, or a single interleaved log, is not specified. Assumed single log with author labels, matching "Messages are labeled by sender and queued in order."
- [ ] A task that moves to a different owner mid-life keeps one conversation under this model. Whether that is right, or whether reassignment should start a segment, is unaddressed by the design. Segment boundary assumed, since it is the same kind of discontinuity as a respawn.
