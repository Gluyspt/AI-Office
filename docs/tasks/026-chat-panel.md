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

- [ ] The panel slides in over any page and closes without losing an unsent draft.
- [ ] Opening it loads the **conversation** from ticket 010 — keyed by task, or by role slot for Management and department leads — and subscribes to live messages for it.
- [ ] **A visible divider renders at each session boundary**, labelled with why the session restarted (paused, model switch, crash) and whether context was restored from a handoff.
- [ ] The divider makes clear that the agent does not remember what is above it. The human sees continuous history; the UI must not imply the agent does. Asserted by reviewing the copy, and by a test that a resumed conversation renders the boundary rather than a seamless join.
- [ ] An agent reply appears within a second of the Stop hook firing, verified end to end against a real session.
- [ ] A sent message appears immediately as pending, becomes sent on acknowledgement, and becomes **failed with a retry** if delivery fails — a message that vanished is indistinguishable from one the agent ignored, and that is the panel's worst failure.
- [ ] Messages are labelled by sender, per the design's requirement that every message is attributed.
- [ ] The panel makes clear that a message **queues until the agent's current turn ends** — the design is explicit that chat alone cannot stop a wrong direction, so the UI must not imply otherwise.
- [ ] Tool activity from the PreToolUse stream renders as compact "recent actions" lines, visually subordinate to the conversation, and can be collapsed.
- [ ] Scrolling up backfills older history across segment boundaries without losing scroll position or duplicating messages.
- [ ] New messages arriving while the user is scrolled up do not yank the view; a "new messages" affordance appears instead.
- [ ] Switching the panel between two conversations never shows one agent's messages under the other's header, asserted with rapid switching while both are active.
- [ ] Message text is rendered as text — a reply containing markup or a script tag is displayed literally, not executed.

## Open questions

- [ ] How much history to load on open is undecided — the API pages, so this is a UI call. A conversation spanning many segments could be long; assumed one screenful plus backfill on scroll.
- [ ] The design mentions live token-by-token streaming via a MessageDisplay hook as a later enhancement, not v1. The panel therefore shows nothing between a message being sent and the turn ending — which can be minutes. Assumed a "working" indicator driven by tool events; if an agent runs long without tools, the panel looks idle. Worth watching in the first real use.
- [ ] Nothing says whether chat history survives a task being delivered and accepted, or whether it belongs to the task detail page (not built in step 3).
