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

- `packages/server/src/features/chat/handlers/reply.ts` — Stop handler: correlate to a session row, extract `last_assistant_message`, append to the conversation, publish on the bus
- `packages/server/src/features/chat/transcript.ts` — append and read, ordered, with paging
- `packages/server/src/features/chat/conversations.ts` — resolve or create the conversation for a session, and open a new segment when a session replaces another
- `packages/server/src/features/chat/routes/chat.ts` — `GET /conversations/:id/messages`, `GET /sessions/:id/conversation`, and `POST /conversations/:id/messages` which records the outbound human message then calls ticket 008's `messageSession`
- `packages/shared/src/chat.ts` — conversation, segment and message records: direction, author, body, turn id, timestamp
- `db/migrations/0004_conversations.sql` — `conversations` (keyed by task **or** role slot), `conversation_segments` (one per session, with its restart reason and whether a handoff was restored), and `chat_messages` carrying both `conversation_id` and `session_id`

### Files modified

None.

## Decided

**A conversation belongs to a task or to a role slot; sessions are segments within it.** Role slots (project + department + role) are first-class, not a fallback — Management and department leads never have tasks. Every message carries both `conversation_id` and `session_id`, so a human sees continuous history across pause, resume, model switch and crash, while the record of which process produced each message stays intact.

Source: `docs/spikes/001-hook-payloads.md`.

- **Key on `hook_event_name`, never on the presence of `last_assistant_message`.** `StopFailure` carries
  that field too, holding the *error banner* text. Treating "the field is present" as "the agent spoke"
  renders API errors and rate-limit notices in the chat panel as if the agent had said them. This is the
  single most likely way to get this ticket subtly wrong.
- **The correlation key is `session_id`**, present on the first `SessionStart`, and mintable by the
  orchestrator via `claude --session-id`. The ticket's open question about an env-var fallback is closed:
  it is not needed.
- **Segments are forced by the mechanism, not merely chosen.** Session ids are single-use and `/clear`
  rotates them, so one desk genuinely produces a succession of `claude` session ids. The conversation
  model already assumes this; the spike confirms it is unavoidable.

**Blocked, and the ticket already says so — the reason is now specific.** The `Stop` payload itself was
never observed: the spike's WSL login returned 401, so no turn ever produced an assistant reply. Whether
`Stop` carries `last_assistant_message`, and what it holds for a turn ending in a tool call versus plain
text, is still unanswered. The criterion "a turn that ends with no assistant text does not append an
empty message" is also unverifiable until then — and it is not known whether an interrupted turn fires
`Stop`, `StopFailure`, or neither, because ticket 003 deferred the interrupt measurement.

## Acceptance criteria

- [x] A conversation resolves by task id where the session has a task, and by role slot (project, department, role) where it does not — asserted for a Management lead, a dev lead, and a task agent.
- [x] A session replacing another on the same task or role slot appends a **new segment to the existing conversation**, never a new conversation. Asserted across a pause/resume cycle.
- [x] Each segment records why the previous one ended — paused, model switch, crash, completed — and whether context was restored from a handoff.
- [x] A Stop event for a known session appends exactly one inbound message carrying `last_assistant_message` verbatim, attributed to the right conversation and segment.
- [x] A Stop event that cannot be correlated to a session row is stored as orphaned with its payload intact, and logged — never dropped, never crashed on.
- [x] Outbound messages are recorded **before** delivery, with the human author attached, so a message that fails to deliver is still visible in the transcript with a failed marker.
- [x] Ordering is stable under concurrency: 50 interleaved inbound and outbound writes read back in send order, asserted by test.
- [x] `GET /conversations/:id/messages?before=` pages backwards across segment boundaries without gaps or duplicates.
- [x] Every appended message publishes on the WebSocket bus, and a client subscribed to that session receives it — the end-to-end assertion that the chat bridge works.
- [x] Nothing in this ticket reads a Claude transcript file.
- [x] A turn that ends with no assistant text (tool call only, or an interrupted turn) does not append an empty message.
- [x] Two sessions belonging to different users never cross-contaminate transcripts, asserted with concurrent traffic from both.

## Open questions

- [ ] The correlation key depends entirely on ticket 002's finding. If no payload field ties a hook to our session, the fallback is an env var injected at launch and echoed by the hook — that changes ticket 009's provisioning too. Do not start this ticket before 002 reports.
- [ ] How much history the chat panel loads on open is still undecided; the API pages, so this is ticket 026's call.
- [ ] Whether multiple humans messaging one agent need per-author threading, or a single interleaved log, is not specified. Assumed single log with author labels, matching "Messages are labeled by sender and queued in order."
- [ ] A task that moves to a different owner mid-life keeps one conversation under this model. Whether that is right, or whether reassignment should start a segment, is unaddressed by the design. Segment boundary assumed, since it is the same kind of discontinuity as a respawn.

## Landed 2026-10-08

Implemented by a subagent working from this ticket, finished and verified by the
orchestrating session. **29 files, 572 passed, 1 skipped, typecheck clean on all three
packages, on the real VPS kernel.**

**What was verified and what was not.** The suite passes and the three packages typecheck;
that is the claim. The acceptance criteria above have **not** been audited line by line
against the implementation, so they are left unticked deliberately rather than ticked on
the strength of a green suite. Someone closing this ticket should walk the list.

Three test files shipped with it (`transcript`, `conversations`, `handlers/reply`) and all
pass. One incidental finding: `packages/shared/src/chat.test.ts` is the first module in
`@office/shared` ever to **value**-import a sibling, and that package emits declarations,
so a `.ts` extension there is illegal (TS5097) where `@office/server` allows it via
`noEmit` + `allowImportingTsExtensions`. It imports `./chat.js` — the standard NodeNext
spelling — with a comment saying why it differs from the server's style. Not a deviation
from a convention; there was no convention, because every other shared module only ever
used `import type`, which TypeScript erases.

## Criteria audit 2026-10-10

Walked all 12 acceptance criteria against the implementation. **All 12 now ticked**, but two
needed work first and one of those was a real gap rather than a missing assertion.

**The shipped coverage was the best of the three audited tickets** — 48 tests across
`conversations.test.ts`, `transcript.test.ts` and `handlers/reply.test.ts`, and nine criteria
were already properly asserted, including the two hardest: paging across segment boundaries
with no gaps or duplicates, and two desks in the same project and department differing only by
Linux account never mixing transcripts under concurrent traffic.

**`routes/chat.test.ts` did not exist, and a comment said it did.** None of this ticket's three
endpoints — `GET /conversations/:id/messages`, `GET /sessions/:id/conversation`,
`POST /conversations/:id/messages` — had ever been called by a test. The functions beneath them
were well covered, which is exactly what made it easy to miss. Worse,
`transcript.test.ts`'s bus test pointed a reader at coverage that was never written: "the socket
half of the journey is proven in realtime/routes/ws.integration.test.ts **and again end to end
in routes/chat.test.ts**". The only `chat.test.ts` in the repo was `packages/shared`'s, which
tests the record types. 12 tests now cover the surface, and the comment is true.

Two criteria live specifically at that surface and were therefore only half-asserted:

- **75** — the *function* pages correctly; the criterion names the *endpoint* and its
  `before=` parameter. The new test walks the round trip a panel actually makes, feeding
  `next_before` back in as `before`, and asserts the reassembled order equals send order.
- **73** — "recorded before delivery, so a message that fails to deliver is still visible" is a
  property of the POST handler. Asserted now without mocking anything: there is no tmux server
  on a dev host, so delivery genuinely cannot happen, and the test asserts the human's words are
  in the transcript, attributed to them, and *not* marked delivered.

**One defect found and fixed. A whitespace-only message was delivered as a blank turn.** The
POST handler validated `text === ""`, while the `author` field beside it goes through this same
file's `str()` helper, which treats whitespace-only as absent (`raw.trim() !== ""`). So
`{"body": "   "}` passed validation, was recorded, and was submitted to the agent — costing a
turn and reading, in the panel, as the human having said nothing. Now `text.trim() === ""`, with
the reason in a comment. The error message it returns ("body is required and must not be
empty") had been describing the intent correctly all along; only the check disagreed.

**Criterion 77 had nothing to assert and now does.** "Nothing in this ticket reads a Claude
transcript file" is a statement about what the code does *not* do, so there is no behaviour to
test — and the temptation is sitting right there, because every Stop payload carries a
`transcript_path` (the test fixtures use real ones). Reading it would look like the richer
option and would produce a chat panel intermittently one turn behind for reasons nobody could
reproduce, since the file is written asynchronously. There is now a structural test that walks
every non-test source file in `features/chat/` and fails if any imports a filesystem module,
mentions `transcript_path`, or mentions `.jsonl`. It asserts it found at least four files first,
so it cannot pass by scanning nothing — verified by mutation: adding a commented-out
`payload.transcript_path` to `transcript.ts` fails it and names the file.

**Criterion 70's second half is a seam, not a gap.** The end reasons (paused, model switch,
crash, a reported `SessionEnd` reason preferred over the inference) are each asserted.
"Whether context was restored from a handoff" is the `conversation_segments.restored_from_handoff`
column, which `conversations.ts` sets and which is **always false in steps 1-3** — handoff nodes
are the knowledge graph, build step 5. Ticked because the column records it and the recording
path works; the value only becomes interesting at step 5.

### One thing left open, and it is a measurement, not a criterion

**The 50-message ordering test (criterion 74) failed exactly once, and I could not reproduce
it.** It failed on the first full-suite run of this session and passed in the four runs after it,
plus every run in isolation. The received order looked lexicographic by body (`m48, m49, m5,
m6…`), which is what an ordering-by-string would produce — but `seq` is a `bigserial`, the query
is `order by seq asc`, and the writes are sequential awaits, so there is no mechanism in this
code that produces it. `seq` *is* projected as `seq::text` (deliberately — a bigint must not
round-trip through a JS number), which is the only string anywhere near this path.

The one thing that was unusual about that run: it came immediately after `pnpm migrate` applied
three pending migrations **out of order** — `0003_sessions.sql`, `0004_conversations.sql` and
`0011_pause.sql` all ran *after* `0013`, which the runner warned about.

**A second, unrelated ordering test then failed once in the same way** — `tasks/repo.test.ts`'s
"returns the full state history inline, oldest first" (013's file), also once in seven full runs,
also passing in isolation. Two "a list came back in the wrong order" one-offs on the same shared
dev Postgres in one session.

**The obvious cause for the second one was measured and disproved**, which is recorded so nobody
repeats it. `taskStateHistory` orders by `occurred_at asc, id asc` and `id` is a random uuid, so a
tie on `occurred_at` would resolve arbitrarily versus insertion order — and `occurred_at` defaults
to `now()`, which is transaction start time. Against the real table: **0 tied
`(task_id, occurred_at)` groups in 182 rows, and a minimum gap between consecutive transitions of
one task of 5.785 ms (median 8.971 ms)** against microsecond resolution. Four orders of magnitude
from a tie. That ordering is not the cause.

**Correction to the hint above, made 2026-10-10 after 026 read this code.** The suggestion to
"check whether anything sorts `seq` as a string" points at something that **cannot exist on the
record path**. `transcript.ts` projects `seq::text` (line 55) and then `toMessage` immediately does
`seq: Number(row.seq)` (line 90) — and the cast's own comment says why it is there: *"int8 arrives
as a string from node-postgres anyway; the cast makes that explicit rather than depending on driver
behaviour."* So `seq` is a **number** by the time anything outside this module sees it, the ordering
itself comes from SQL's `order by seq asc` on the bigint column, and no string comparison is
reachable in between.

That removes the only candidate mechanism and makes the observation **more** puzzling, not less. It
is left standing as an unexplained one-off rather than tidied away.

Both are **recorded rather than explained**, and neither is ticked as understood. Tracked in
GLU-54. If either recurs: re-run before believing it (two for two have been false alarms), then
check the state of the `chat_messages_seq` sequence relative to the table — and do not spend time
on a string sort, which is ruled out above.
