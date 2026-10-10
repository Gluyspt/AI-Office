---
id: "026"
title: Chat panel
build_step: 3
department: dev
estimated_model: opus
blocked_by: ["010", "022"]
---

# 026 — Chat panel

**Build step:** 3 — Tasks page and chat panel
**Department:** dev
**Estimated model:** opus — this is the interface the whole system is judged by; the interaction design is the work.
**Blocked by:** 010, 022

## Why

"If the chat bridge doesn't work, nothing above it matters." Ticket 010 proved the bridge; this ticket
makes it usable. The design specifies the panel's contents: the agent's recent actions, its replies from
the Stop hook, a model chip, Interrupt and Kill, and a blocked banner.

Controls and the blocked banner are ticket 027, so this ticket owns the conversation surface itself.

## Scope

### Files created

- `packages/web/src/features/chat/overlay.tsx` — registers the panel with ticket 022's overlay host
- `packages/web/src/features/chat/ChatPanel.tsx` — the slide-in container, agent header, open and close
- `packages/web/src/features/chat/ChatTranscript.tsx` — message list, recent actions interleaved, backfill on scroll
- `packages/web/src/features/chat/ChatComposer.tsx` — input, send, pending and failed states
- `packages/web/src/features/chat/useAgentChat.ts` — history load, live subscription, send
- `packages/web/src/features/chat/chat.css`

### Files modified

None.

## Acceptance criteria

- [x] The panel slides in over any page and closes without losing an unsent draft. The draft half is
      tested through the overlay (type, close, reopen, and a second desk's composer stays empty).
      **The slide itself is not verified**: jsdom applies no transforms and runs no transitions, so
      the test can only assert that `data-open` flips — the `translateX` and its 160 ms ease-out are
      CSS. Needs a real browser; belongs with 030.
- [x] Opening it loads the **conversation** from ticket 010 — keyed by task, or by role slot for Management and department leads — and subscribes to live messages for it.
- [x] **A visible divider renders at each session boundary**, labelled with why the session restarted (paused, model switch, crash) and whether context was restored from a handoff.
- [x] The divider makes clear that the agent does not remember what is above it. The human sees continuous history; the UI must not imply the agent does. Asserted by reviewing the copy, and by a test that a resumed conversation renders the boundary rather than a seamless join.
- [ ] An agent reply appears within a second of the Stop hook firing, verified end to end against a
      real session. **UNVERIFIABLE HERE** — it needs a live `claude` desk under tmux on the target
      host, and this ticket was built on a Windows dev box with no agent session. The panel's half of
      the latency *is* asserted: an inbound `ChatMessageAppended` renders from the event payload with
      no second fetch, which is what makes one second reachable at all. The end-to-end measurement
      belongs with 030 (and with 011's spine runbook, which drives a real Stop hook).
- [x] A sent message appears immediately as pending, becomes sent on acknowledgement, and becomes **failed with a retry** if delivery fails — a message that vanished is indistinguishable from one the agent ignored, and that is the panel's worst failure.
- [x] Messages are labelled by sender, per the design's requirement that every message is attributed.
- [x] The panel makes clear that a message **queues until the agent's current turn ends** — the design is explicit that chat alone cannot stop a wrong direction, so the UI must not imply otherwise.
- [x] Tool activity from the PreToolUse stream renders as compact "recent actions" lines, visually
      subordinate to the conversation, and can be collapsed. The structure and the collapse are
      tested (an action line is never inside a `.chat-message`, and the toggle removes every line).
      **"Visually subordinate" is not measured** — no bubble, no surface, `--text-sm`,
      `--text-muted` and a left rule, but type size and contrast need a real render. 030.
- [x] Scrolling up backfills older history across segment boundaries without losing scroll position
      or duplicating messages. Backfill and de-duplication are tested through the real cursor round
      trip (`next_before` fed back as `before`, a re-delivered page adding nothing). **The
      scroll-position half is NOT VERIFIED**: jsdom reports every element as 0×0 and does not
      scroll. What is asserted is the decision it rests on — `scrollTopAfterPrepend` preserves the
      distance from the *bottom*, and it runs in a layout effect so the correction lands before
      paint. 030.
- [x] New messages arriving while the user is scrolled up do not yank the view; a "new messages"
      affordance appears instead. Tested by installing `scrollHeight` / `clientHeight` by hand,
      scrolling up, and emitting a message: the affordance appears, `scrollTop` does not move, and
      clicking it jumps to the end. **That the view does not visibly jump is still a browser
      claim** — jsdom has no layout. 030.
- [x] Switching the panel between two conversations never shows one agent's messages under the other's header, asserted with rapid switching while both are active.
- [x] Message text is rendered as text — a reply containing markup or a script tag is displayed literally, not executed.

## Open questions

- [x] **Answered: one page of 50 on open, then backfill on scroll.** 50 is comfortably more than a
      screenful at three or four lines a message, so there is something to scroll into immediately
      and the first paint costs one round trip; a conversation spanning many segments can be
      thousands of messages, and loading it to render a panel would make opening one slowest in the
      office where the most has happened. The limit is passed explicitly rather than inherited from
      the server's `DEFAULT_PAGE_SIZE` (which is also 50) — inheriting a default means the panel's
      behaviour changes silently when a server constant does. `loadOlder` feeds `next_before` back
      in as `before`, so the API's paging is genuinely used, not decorative.
- [x] **Answered, with its cost stated rather than hidden.** There is no token-by-token streaming,
      so the panel has exactly two facts between a send and the turn ending: tool calls arriving,
      and an outbound message having been delivered. It reports them as what they are — *"Last seen
      using Bash — pnpm test, 2m ago"* and *"Waiting for the agent's turn to end. Nothing appears
      here until it does — there is no live streaming of its output in this build."* No spinner and
      no "working…", because an agent that thinks for ten minutes without calling a tool **does**
      look idle here, and a timestamped last-action line makes that visible instead of animating a
      claim. Worth watching in the first real use, as the ticket says.
- [ ] Nothing says whether chat history survives a task being delivered and accepted, or whether it belongs to the task detail page (not built in step 3). **Still open, and nothing in the panel depends on the answer**: it reads a conversation by id and pages backwards, so history living on past acceptance costs it nothing, and a task-detail home for it would reuse `ChatPanel` through the `conversation` target. 031 opens the panel from a task card; whoever answers this does not have to change this ticket's files.

## Landed 2026-10-10

Seven files, all inside this ticket's declared scope: `overlay.tsx`, `ChatPanel.tsx`,
`ChatTranscript.tsx`, `ChatComposer.tsx`, `useAgentChat.ts`, `chat.css`, plus `chat.test.tsx`
beside them — the same precedent 023 (`board.test.tsx`) and 024 (`task-card.test.tsx`) set, and a
different path from 030's `tests/ui/chat.test.tsx`. **Nothing outside
`packages/web/src/features/chat/` was created or edited: no new dependency, no change to
`lib/api.ts`, `lib/ws.ts`, `overlays.tsx` or `__root.tsx`.** The overlay convention held — the
panel mounts through `import.meta.glob("../features/*/overlay.tsx")` with no shell edit, which is
what 022 said it would be proven by.

**Suite: 673 passed, 1 skipped, 32 files** (baseline 624 / 1 / 31 — exactly the 49 this ticket
adds, in one new file). Typecheck clean on all three packages.

### Decided during implementation

- **One page of 50 on open, then backfill.** See the answered open question above.

- **The panel opens two WebSocket streams, and that is a cost, not a preference.** Chat and segment
  events carry `project_id` and use the *claude* session id as the event's session id; hook events
  (`PreToolUse`, the recent-actions stream) have `project_id` NULL by construction — "nothing in a
  hook payload identifies a project" (`events/ingest.ts`). So one filter cannot see both. Chat
  traffic is watched **by project** and matched on `conversation_id`, because watching it by claude
  session id would make the panel go quietly dead the moment `/clear` rotates that id — the
  silently-stale failure this app cares most about. Tool traffic is watched **by claude session
  id**, because that is the only correlation a hook event has. `routes/ws.ts` already supports
  several subscriptions per socket; 022's `openEventStream` sends exactly one subscribe frame, and
  `lib/ws.ts` is not this ticket's file. A later ticket that teaches the client to carry a list of
  filters collapses this to one socket by deleting a call here.

- **The transcript renders a message from the event payload rather than refetching it.** This is the
  opposite of what `useBoard` does, deliberately: a task event is *not* a task row, so patching a
  card from one is a chance to be subtly wrong — whereas a `ChatMessageAppended` payload *is* the
  message, and 010 says so in `announce` ("the body rides along so a subscribed client renders the
  message without a refetch"). That is also the only way the one-second reply criterion is
  reachable. `messageFromEvent` returns null when a payload has nothing renderable, but **never
  over a missing `seq`** — that sorts to the end, where a just-arrived message belongs; dropping it
  would be the vanishing failure in a different costume.

- **An optimistic send is its own shape, not a faked `ChatMessageRecord`.** Faking one would mean
  inventing a `segment_id`, a `seq` and a `created_at` the server has not assigned — the same
  mistake as rendering a token cost of 0. `LocalMessage` has four fields and is replaced by the
  server's row the instant one exists. Reconciliation matches on author + body, because the server
  mints the id and the two have nothing else in common; without it, a message sent while its own
  WebSocket event is in flight appears twice (asserted, and the assertion was checked by breaking
  it).

- **A retry sends a new message; it does not re-deliver the old one.** There is no re-delivery
  endpoint, and inventing one in the UI would mean the panel claiming a capability the orchestrator
  does not have. The failed row stays visible, marked failed, and the retry appends a fresh message
  — which is also the honest record of what happened.

- **`queued` is rendered as a dead end, because it is one.** "Not delivered — the agent had a
  permission dialog open. Nothing will re-send it: send it again once the dialog is cleared." 008
  refuses to deliver into an open dialog because delivering there *approves the pending tool call*
  (confirmed on the target 20/20), and nothing re-drains that queue. A "queued, sending soon"
  affordance would have been a lie with a tool call at the end of it.

- **The model chip is a `<span>`, not a button.** Live model switching is unavailable until step 11,
  and the design puts a clickable model chip on the agent card — so the chip renders with
  `title="Switching an agent's model while it runs is not available in this build"` and no
  affordance. 027 owns Interrupt, Kill and whatever the switch becomes; they arrive through
  `headerSlot`.

- **Ticket 027 can land without editing a file this ticket owns.** 027's scope is
  `AgentControls.tsx` and `BlockedBanner.tsx` in this directory and *nothing that could mount
  them*. `overlay.tsx` therefore collects sibling modules by glob, and a module **opts in** by
  exporting `chatSlot = "header" | "banner"` alongside its default component. The opt-in is the
  load-bearing half: a glob that mounted every sibling would hand 027's file props it never agreed
  to and crash the panel, whereas a module without the marker is simply not mounted — a visible gap
  instead of a broken panel. The literal-path behaviour of `import.meta.glob` was verified by doing
  it, 022's method: a throwaway `AgentControls.tsx` appeared in the map, its absence yielded `{}`,
  and it was then deleted.

- **The panel unmounts when it closes, so the draft lives in the overlay.** 022's overlay host gives
  anything an overlay renders `pointer-events: auto`, so a closed panel left in the DOM would be an
  invisible click target over the whole page. The overlay component stays mounted for the life of
  the app and holds drafts keyed by target — which is also what keeps one desk's half-written
  instruction out of another desk's composer.

- **Actions are anchored to a turn, not to a clock.** `prompt_id` is on both a `PreToolUse` payload
  and an agent reply, so a tool group renders immediately before the reply that ended its turn.
  Interleaving by timestamp would have ordered the panel with the same wall clock ticket 010 watched
  step *backwards* twice in one session. Actions for a turn with no reply yet sit at the tail, which
  is where the activity line reads them from.

- **Only `PreToolUse` is consumed.** `PostToolUse` carries the tool's entire output — whole file
  bodies — and adds nothing a one-line activity entry needs.

### Verification, and what it does not cover

Every load-bearing behaviour was checked by **breaking it on purpose and watching the test go red**,
then restoring:

| Mutation | Test that caught it |
| --- | --- |
| `buildTranscriptRows` never emits a divider | 3 failed, including "renders the session boundary rather than a seamless join" |
| `normaliseMessage` stops converting `seq` | "sorts by seq numerically even when the wire hands it a string" |
| the optimistic bubble is never reconciled | "does not double a message whose own event arrives before the response" |
| the stale-result guard always returns true | "never shows one conversation's messages under another's header" |
| new messages always follow the live end | "offers a 'new messages' affordance instead of yanking a reader to the end" |

**Everything jsdom cannot do is marked in the criteria above and belongs to 030**: the slide-in
transition, the 400 px layout, real scrolling and scroll-position survival, whether action lines
*read* as subordinate, and any contrast measurement. The one criterion that needs a live agent — a
reply within a second of the Stop hook — is unverifiable on this machine and is called out as such
rather than ticked on the strength of the code looking right.

### Two things worth knowing that this ticket did not change

- **`ChatMessageRecord.seq` is a JS `number` by the time it reaches the web app.** `transcript.ts`
  projects `seq::text` precisely because "a bigint must not round-trip through a JS number", then
  converts with `Number(row.seq)` three lines later — so the precaution ends at the row mapper and
  the API serialises a number. Harmless until a conversation's `seq` passes 2^53, which it never
  will, but the comment and the code disagree about why. Not this ticket's file; reported rather
  than touched. This feature re-converts at every entry point anyway, so a server that one day sends
  the string still sorts correctly here — that is the second mutation test above.
- **`currentSegment()` returns `previousEndReason: null` always** — only `listSegments()` derives it,
  with `lag()`. The panel therefore takes its segments from the page response and never from
  `current_segment`, which is why the divider has a reason to show at all. Anything else reading
  `GET /sessions/:id/conversation` for boundary labels will get nulls.
