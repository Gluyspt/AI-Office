# Spike 001 — Claude Code hook payloads and blocking semantics

**Ticket:** [002](../tasks/002-spike-hook-payloads.md) · **Department:** research · **Observed:** 2026-09-21/22

> **Third pass, 2026-09-22, closing two named gaps.** Claude Code `2.1.278` at the start **and** at the
> end of this pass (checked twice again). Two questions were measured and both are answered:
> **`SessionStart` after `/clear`** (§7 — still not delivered over `http`, and this time the http
> transport is *proven live* at that instant) and **`TaskCreated` / `TaskCompleted`** (§5b — they are
> the *teammate task-board* hooks and cannot fire in an ordinary session; the subagent hypothesis is
> wrong, and what actually fires is `SubagentStart` / `SubagentStop`, neither of which the design
> registers). Two further items were deliberately **not** attempted and stay in "Not observed":
> automatic `PreCompact` (needs a filled context window; the expected delta is only a `trigger` value)
> and a rate-limit `StopFailure` (would mean deliberately exhausting the human's only account).
> Nothing earlier in this document was rewritten.

> **Second run, 2026-09-22, after the WSL login was repaired.** Claude Code was **still `2.1.278`** at
> the start and end of the re-run (checked twice, as the binary self-updates). The re-run closed the
> blocked items: the chat bridge end to end (§1), the `PreToolUse` blocking shape (§2), `Stop` and the
> tool-call payloads (§4, §5), and the self-signed-certificate question (§12). Everything the first run
> settled was left untouched. **Re-run observations ran over `https`** with a trusted self-signed CA —
> see §12 for what that costs.

**Everything below was observed on Claude Code `2.1.278`** (`claude --version`), Ubuntu 24.04.4 LTS
under WSL2, Node 22.23.2, tmux 3.4. Hook behaviour is Claude Code behaviour and transfers to the VPS
unchanged; wall-clock numbers do not — they are a dev laptop's, and are reported so the *shape* of
the cost is known, not its VPS value.

> The ticket brief cited `2.1.178`. The binary self-updated during the spike; **2.1.278** is what
> every observation below ran on. Re-check these findings after a Claude Code upgrade — several of
> them are undocumented behaviours, not contracts.

> **Update after this spike ran — transport changed to https.** Everything recorded below was observed
> over plaintext `http://127.0.0.1:8787`, because that is what the design specified at the time. The
> system has since decided on **https everywhere, loopback included** (see the ticket index,
> "Decisions made"), and `spikes/hooks/echo-server.mjs` and `settings.spike.json` have been moved to
> TLS. The observations here are left exactly as they were made rather than rewritten — they are the
> experimental record, and the payload shapes, blocking semantics, correlation field and timings are
> transport-independent.
>
> **One finding below is now a live risk rather than a footnote:** it is untested whether Claude Code's
> hook client accepts a self-signed certificate. If it refuses, hooks fail the TLS handshake and *no
> event arrives* — which looks identical, from the orchestrator's side, to a hook that never fired.
> The echo server now logs handshake rejections distinctly (`tlsClientError` → `unknown ca`) so the two
> are told apart, and this is the first thing the post-`/login` re-run should check. If the cert is
> refused, the fix is a trusted local CA or `NODE_EXTRA_CA_CERTS` exported into every agent session —
> not a fallback to plaintext.
>
> **Answered on the re-run: the cert *is* refused, and `NODE_EXTRA_CA_CERTS` *is* the fix. See §12.**

## Verdict, in one table

| Question | Answer | Confidence |
| --- | --- | --- |
| Chat bridge end to end (send-keys → agent → `Stop` → listener) | **Yes — proven.** `send-keys` → `UserPromptSubmit` at the listener in **101 ms**; agent replies; `Stop` arrives **2.6 s** after Enter carrying the reply text. See §1. | high |
| Can an `http` hook block? | **Yes** — verified on `UserPromptSubmit` *and now on `PreToolUse`*. A `200` whose body is `{"decision":"block","reason":"…"}` blocks both. | high |
| Can an `http` hook block a **`PreToolUse`**, and with what shape? | **Yes.** `hookSpecificOutput.permissionDecision:"deny"` blocks it (the tool never runs) — the documented shape, inert on `UserPromptSubmit`, authoritative here. Top-level `decision:"block"` also works. **`continue:false` does *not* block: the tool runs, and no turn-end event fires at all.** See §2b. | high |
| Does a `command` hook exit 2 block, and can it reach the event server first? | **Yes**, both verified. | high |
| Correlation field | **`session_id`**, on every payload, including the *first* `SessionStart`. The orchestrator can choose it: `claude --session-id <uuid>` works on an interactive TUI launch. | high |
| Does `Stop` carry `last_assistant_message`? | **Yes** — the turn's last *assistant text block*, verbatim. On a turn that used a tool and then spoke, it holds the text **after** the tool call; tool output never appears in it. A turn that truly halts *at* a tool call fires no `Stop` at all. See §4b. | high |
| Does an **interrupted** turn (Escape) fire `Stop`, `StopFailure`, or neither? | **Neither.** Observed twice: the only event for an interrupted turn is its opening `UserPromptSubmit`. Busy/idle needs a watchdog. See §4b. | high, reproduced 2× |
| Does the hook client accept a **self-signed** cert? | **No.** The handshake is rejected (`unknown ca`) and no event arrives, almost silently. `NODE_EXTRA_CA_CERTS` exported into the agent's environment fixes it completely. See §12. | high |
| Retry on non-2xx? | **No.** Exactly one delivery, error shown to the agent, action proceeds. | high |
| Does the design's hook config work as written? | **No.** `SessionStart` is never delivered to an `http` hook — **at launch *or* after `/clear`**. See §7. | high, reproduced 5× |
| Do `TaskCreated` / `TaskCompleted` fire for a subagent or a background task? | **No.** They are the **teammate task-board** hooks (`task_id`, `task_subject`, `teammate_name`), behind a feature gate, and cannot fire in an ordinary session. Subagent activity fires **`SubagentStart` / `SubagentStop`** instead — events the design does not register. See §5b. | high |
| What links a subagent back to its parent? | **The parent's own `session_id`**, on every subagent event, plus `agent_id` / `agent_type`. A subagent is not a separate session. See §5b. | high |

## 1. The chat bridge — **it works, end to end**

**Proven on the 2026-09-22 re-run, on `2.1.278`, over https.** A real `claude` TUI in tmux, hooks
pointed at the echo server, a message driven in with `tmux send-keys`, the agent's reply arriving back
at the listener in the `Stop` payload's `last_assistant_message`. No part of the loop needed the
transcript file, a PTY scrape, or any parsing of the TUI.

```
tmux new-session -d -s spike002-tui -x 100 -y 30 -c <cwd> \
  -e NODE_EXTRA_CA_CERTS=<cert> "claude --settings <spike settings> --session-id <uuid>"
tmux send-keys -t spike002-tui -l "reply with exactly the word ready"
tmux send-keys -t spike002-tui Enter
```

| Hop | Δ from Enter |
| --- | --- |
| `UserPromptSubmit` POST received by the listener — the "delivered" tick | **+101 ms** |
| `Stop` POST received, carrying `"last_assistant_message": "ready"` | **+2.616 s** |

The +101 ms inbound half matches the first run's 114 ms. The outbound half is dominated entirely by
the model turn itself (the TUI showed `Cooked for 2s`); hook dispatch and https delivery on loopback
are sub-millisecond, per §2's transport measurements. **A chat panel built on `UserPromptSubmit` +
`Stop` costs about a tenth of a second of bridge latency in each direction, and nothing else.**

Three practical notes for ticket 010:

- The reply arrives as **one whole message at turn end**, not as a stream. There is no token-by-token
  hook. A "typing" indicator has to be driven from `UserPromptSubmit` (start) and `Stop` (end), and
  the panel shows nothing in between except tool-call events.
- `stop_hook_active: false` is on the payload — the guard against a `Stop` hook that itself restarts
  the agent. Ingest should ignore, but not choke on, a payload where it is `true`.
- `permission_mode` on the payload read `auto` here, because the TUI launched in auto mode by default.
  It is per-session state visible on every event, which is worth surfacing in the UI.

### What the first run proved, and the blocker it hit *(kept as the record)*

**This is the result that matters and it is incomplete.** The blocker is not architectural: every
`claude` invocation in WSL — with and without the spike settings, `-p` and interactive, across ~10
attempts over 20 minutes — returns:

```
Please run /login · API Error: 401 OAuth access token is invalid.
```

The TUI banner still reads `Claude Pro`, so the install believes it is logged in; the stored access
token is refused by the API and is not being refreshed (`~/.claude/.credentials.json` mtime never
changed across attempts). The WSL clock is within 110 ms of the Windows host and `api.anthropic.com`
answers in 320 ms, so this is neither clock skew nor network. **No credential file was read, copied
or moved.**

### What *was* proven, with timings

A real `claude` TUI in tmux (`spike002-tui`), hook config pointed at the echo server, driven by
`tmux send-keys`:

| Hop | Wall clock | Δ from Enter |
| --- | --- | --- |
| `tmux send-keys -t spike002-tui Enter` | `1790009675.129` | — |
| `UserPromptSubmit` POST received by the listener | `1790009675.243` | **+114 ms** |
| Turn ends (auth failure); `StopFailure` POST received | `1790009677.801` | **+2.672 s** |
| `Stop` POST | never — the turn produced no assistant reply | — |

So: **keystrokes reach a live TUI, the TUI fires a hook, and the hook reaches an HTTP listener
114 ms later.** The turn-end hook fires and delivers within ~2.7 s of the prompt. The one untested
link is whether `Stop` — rather than `StopFailure` — arrives carrying the agent's text in
`last_assistant_message`.

Everything in the chain except the model itself is therefore demonstrated: tmux input, the TUI's
prompt submission, hook dispatch, HTTP delivery to a listener, and turn-end delivery.

### What the human had to do to close it — **done, 2026-09-22**

```bash
wsl -d Ubuntu
claude                    # then /login, complete the browser flow
claude -p "say ready"     # must print ready, not a 401
```

Then re-run §11's reproduction. The outstanding items are §4 (`Stop`), §5's "Not observed" table, and
the `PreToolUse` half of §2. Everything else in this document is already settled.

The login was repaired and all three were closed on the re-run. The cause of the original 401 was
never diagnosed — §10.3's hypothesis (two logins of one account invalidating each other) is neither
confirmed nor ruled out, and it remains a live operational risk for a system that runs several agents
on one account.

## 2. Can an `http` hook block?

**Yes.** Four response shapes were tried against a live session on `UserPromptSubmit` — the only
blocking-capable event reachable without the model (see the caveat). The echo server was told at
runtime what to answer, so all four ran inside one session:

| # | Echo server response | Result |
| --- | --- | --- |
| 1 | `200` `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","permissionDecision":"deny","permissionDecisionReason":"…"}}` | **Not blocked.** The prompt went through. |
| 2 | `200` `{"decision":"block","reason":"spike002 top-level block"}` | **Blocked.** Agent saw: `UserPromptSubmit operation blocked by hook:` / the reason / `Original prompt: …` |
| 3 | `200` `{"continue":false,"stopReason":"spike002 continue false"}` | **Blocked.** Agent saw `Operation stopped by hook: <stopReason>`. |
| 4 | `500` `{"error":"…"}` | **Not blocked.** Agent saw `UserPromptSubmit hook error` / `HTTP 500 from http://127.0.0.1:8787/events/prompt?src=project`, then proceeded. |

Blocking is therefore carried by the **body of a 2xx**, not by the status code — and, for this event,
by the *top-level* `decision` / `continue` fields rather than the `hookSpecificOutput` wrapper.

> **The caveat ticket 020 must not skip.** No tool call could be produced without model auth, so
> `PreToolUse` never fired. The public hooks reference states `PreToolUse` blocks on
> `hookSpecificOutput.permissionDecision: "deny"` — which is exactly the shape that did **not** block
> `UserPromptSubmit` here. The field mapping is genuinely per-event. **Before building the guard,
> fire one `PreToolUse` with each of shapes 1–3 and record which one wins.** It is a five-minute
> test once login works.
>
> **Run on the re-run. Answered below — and the field mapping *is* per-event, exactly as feared.**

### 2b. `PreToolUse` — the blocking shape, measured *(re-run, 2.1.278)*

Four shapes fired against a live `Read` tool call in the TUI (`read ./note.txt`), one per turn, the
echo server switched between turns. "Tool ran?" is read off whether `PostToolUse` fired **and** what
its `tool_response` contained — the only trustworthy witness.

| # | Echo server response to `PreToolUse` | Tool ran? | Turn ended with `Stop`? | Verdict |
| --- | --- | --- | --- | --- |
| 1 | `200` `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"…"}}` | **No** — no `PostToolUse` at all | yes | **BLOCKS.** The documented shape works here. |
| 2 | `200` `{"decision":"block","reason":"…"}` | **No** — no `PostToolUse` at all | yes | **BLOCKS.** |
| 3 | `200` `{"continue":false,"stopReason":"…"}` | **YES — the file was read in full** | **NO `Stop`, no `StopFailure`** | **DOES NOT BLOCK.** Dangerous — see below. |
| 4 | `500` `{"error":"…"}` | n/a (the model answered from context and made no call) | yes | inconclusive; §6's non-2xx finding stands |

**The shape to build ticket 020's guard on, verbatim — either of these two, and shape 1 is the one to
prefer because it is the documented contract and it is the one that renders as a permission denial
rather than an error:**

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "src/db/schema.ts is owned by task 41 (agent dev-2). Ask, or pick another file."
  }
}
```

Both blocking shapes feed the reason straight into the agent's context, and the agent handled it
gracefully and **did not retry** — it stopped and asked the human. The text the guard writes is read
by the agent as an explanation, so it should say what to do next, not just refuse.

So `UserPromptSubmit` and `PreToolUse` **do not share a blocking vocabulary**: `permissionDecision`
is inert on `UserPromptSubmit` (shape 1, §2) but authoritative on `PreToolUse`. Top-level
`decision: "block"` is the one shape that blocked **both**. Any generic "blocking hook response"
helper in the orchestrator must be per-event, or must emit both fields at once.

#### `continue: false` is a trap, and it is worth a ticket of its own

Shape 3 was tested twice, the second time against a file the session had **never read**, to rule out
Claude Code's unchanged-file cache. Both times:

- `PreToolUse` fired, the echo server answered `{"continue":false,…}`, **and the tool executed
  anyway** — `PostToolUse` arrived carrying the file's full text in `tool_response`.
- The TUI printed `PreToolUse:Read hook stopped continuation: <stopReason>` and the turn ended there
  with no assistant reply.
- **Neither `Stop` nor `StopFailure` ever fired.** Waited >20 s after the turn visibly finished.

Two consequences:

1. **For the guard (020):** `continue: false` reads like the strongest possible refusal and is the
   weakest — it lets the read or the write happen and only then halts the agent. Using it as the
   ownership guard would leak exactly the content the guard exists to protect. Use
   `permissionDecision: "deny"`.
2. **For the chat panel (010, 005):** there is at least one real path by which **a turn ends and no
   turn-end event is delivered at all**. Anything that treats `Stop`/`StopFailure` as a guaranteed
   bookend — a spinner, a "thinking" state, a desk marked busy — will hang there forever. A turn-end
   watchdog is not optional.

### The `command`-hook fallback works, and reaches the event server

The probe script POSTs the payload to the event server, then `exit 2` with a message on stderr.
Observed in this order: the POST arrived at the listener, *then* the agent was blocked with

```
UserPromptSubmit operation blocked by hook:
  [~/spike002-tmp/hooks/cmd-hook-block.sh]: spike002: blocked by ownership guard (command hook exit 2). server said: {}
```

The script path is prefixed onto the message the agent sees, so the guard's feedback text has to read
sensibly with that prefix in front of it. Note also that **every hook in the group still ran and
delivered even though one of them blocked** — the event server sees the attempt regardless of the
verdict, which is what ticket 020's "unguarded edits" record needs.

### Added latency of the command-hook path

Two measurements, because neither alone is honest. `n = 25` and `n = 20`; min / p50 / p95 / max.

| What | Method | ms |
| --- | --- | --- |
| Command hook, full cost | 25 external runs of the real hook script with a realistic `PreToolUse` payload on stdin — bash spawn + curl spawn + HTTP round trip | **18 / 19 / 21 / 61** |
| HTTP transport alone | 25 bare `curl` POSTs to the same listener | **0.69 / 0.78 / 0.96 / 0.97** |
| Command hook, in situ | 20 real hook dispatches from the live TUI: the hook's own `t_start` → POST received at the listener (excludes process spawn, invisible from inside) | **9 / 10 / 38 / 38** |

**~20 ms per tool call** is the number to hand ticket 020, and it is almost entirely process spawn:
the HTTP call itself is under a millisecond on loopback. An `http` hook pays the sub-millisecond
transport and no spawn. On a shared VPS under load, the spawn term is the one that grows.

**Hooks in one group run concurrently, not serially.** In 19 of 20 in-situ samples the `http` hook's
POST arrived *before* the command hook had even started (median −6 ms). Adding a command hook
alongside an http hook costs the command hook's own duration, not the sum of the two.

**Do not leave the timeout at its default.** Against a deliberately slow listener (30 s delay):

- the default hook timeout is **30 s**, and the turn is held for all of it:
  `UserPromptSubmit hook timed out after 30s — output discarded. Raise the hook's "timeout" to allow more time.`
- `"timeout": 2` on the hook entry is honoured for **both** `http` and `command` entries — verified;
  the turn resumed at ~2 s with the same message. Ticket 020's "~2 s, fail open" decision is
  implementable exactly as written, but only if the key is set explicitly: the default would stall
  every tool call for 30 s whenever the orchestrator is wedged.
- A slow `SessionStart` hook holds the session *unusable* for its whole timeout — the TUI showed
  `running SessionStart hook · 19s` and queued the typed prompt behind it.

The `http`-versus-`command` decision is handed to **ticket 020** with the above. It is not settled here.

## 3. What correlates a hook payload to an orchestrator-started session?

**`session_id`.** Present on every payload captured, `http` and `command` alike, and present on the
**first `SessionStart`** — not only afterwards.

Better still, **the orchestrator can choose it**: `claude --session-id <uuid>` is accepted on an
*interactive* TUI launch (the flag is not `--print`-only), and the value comes straight back on the
first `SessionStart`:

```
tmux new-session -d -s <name> -c <cwd> "claude --session-id 11111111-2222-4333-8444-555555555555 …"
→ SessionStart { "session_id": "11111111-2222-4333-8444-555555555555", "source": "startup", … }
```

So the orchestrator mints the UUID, records it against the desk *before* the session exists, and every
later event self-identifies. No `cwd`-plus-tmux-session-name heuristic is needed.

Three constraints on that, all verified:

1. **A `--session-id` is single use.** Relaunching with an id already used exits 1 with
   `Error: Session ID <uuid> is already in use.` A restarted desk needs a **fresh** UUID (or
   `--resume`). This matches ticket 010's decided model — a conversation spans many session segments —
   but it means the orchestrator's stable key is *its own* desk/conversation id, and `session_id` is
   only the segment key.
2. **`/clear` rotates the session id.** It emits `SessionEnd` with `reason: "clear"`, and subsequent
   events carry a new `session_id`. Anything keyed on `session_id` alone loses the desk at `/clear`.
3. **`http` hooks get no environment** — only the JSON body. The env-var route works, but only through
   a `command` hook: launching with `OFFICE_SESSION=office-desk-42` and echoing `$OFFICE_SESSION` from
   the hook script returned it intact. Also available to command hooks: `CLAUDE_PROJECT_DIR` (set) and
   `TMUX_PANE` (set, e.g. `%4`). **`CLAUDE_SESSION_ID` is *not* set** — empty in every invocation.
   Use the payload's `session_id`; treat `OFFICE_SESSION` as belt-and-braces only.

## 4. Does `Stop` carry `last_assistant_message`?

**Not observed — no successful turn was possible.** What *was* observed sits right next to it and
matters anyway:

`StopFailure` carries `last_assistant_message`, and it holds the **error banner, not agent prose**:

```json
{
  "hook_event_name": "StopFailure",
  "error": "authentication_failed",
  "last_assistant_message": "Failed to authenticate. API Error: 401 OAuth access token is invalid."
}
```

Two consequences for tickets 005 and 010, independent of whether `Stop` behaves as documented:

- **The presence of `last_assistant_message` is not proof of a reply.** Ingest must key on
  `hook_event_name`, never on "this payload has a message field, so post it to the chat panel" — or
  the panel will render API errors as agent speech.
- `StopFailure`'s error name is `error` (a short code such as `authentication_failed`), **not** the
  `error_type` / `error_message` pair the public reference describes. Trust the capture.

Still open, and the first thing to run after login: what `last_assistant_message` holds for a turn
that **ended in a tool call** versus one that **ended in plain text**. Both cases must be triggered
deliberately; neither was reachable here.

### 4b. `Stop`, observed *(re-run, 2.1.278)*

**`Stop` fires and carries `last_assistant_message`** holding the agent's final prose verbatim. The
full payload is in §5. Four turn shapes were driven deliberately:

| Turn | `Stop` fired? | `last_assistant_message` |
| --- | --- | --- |
| **Plain text** — "reply with exactly the word ready" | yes, +2.6 s after Enter | `"ready"` — the reply exactly, no decoration |
| **Ended in a tool call then text** — "read ./note.txt and reply with only the magic word" | yes, +5.4 s | `"pomegranate"` — the text *after* the tool call. Tool output is **not** in this field |
| **Tool call blocked by a hook** | yes | the agent's prose about being blocked — ordinary assistant text, indistinguishable in shape from a normal reply |
| **Tool call + `continue:false`** (turn halts at the tool) | **NO event of any kind** | — |
| **Interrupted with Escape mid-turn** | **NO event of any kind** | — |

So the honest statement of what the field holds: **`last_assistant_message` is the last *assistant
text block* of the turn.** A turn that emits text, calls a tool, and emits more text yields only the
final text. Tool calls and their results never appear in it — the chat panel gets them from
`PreToolUse` / `PostToolUse` or not at all.

#### An interrupted turn fires neither `Stop` nor `StopFailure` — ticket 010's open criterion, answered

**Observed twice.** A long generation was started from `send-keys`, left running ~3.5–4 s (the TUI
showing `esc to interrupt`), then `tmux send-keys -t <session> Escape`. In both runs, over a 20–25 s
wait afterwards, the *only* event delivered for that turn was the `UserPromptSubmit` at its start.
**No `Stop`. No `StopFailure`. No `SessionEnd`. Nothing.**

The TUI also **restores the interrupted prompt into the input box**, so an orchestrator that
interrupts and then immediately `send-keys` a new message will concatenate the two into one prompt
unless it sends `C-u` first.

This is the second of the two paths (with `continue:false`, §2b) by which a turn ends and nothing
tells the orchestrator. Together they settle the design question:

> **A desk cannot be marked idle by the arrival of `Stop`.** The orchestrator needs a turn-end
> watchdog — an inactivity timer armed at `UserPromptSubmit` and disarmed by `Stop`/`StopFailure` —
> or a desk will sit "thinking" forever the first time a human hits Escape. Ticket 010's acceptance
> criterion should read "on `Stop`, **or on the watchdog firing**".

## 5. Captured payloads

Redacted: real UUIDs → `<uuid>`, home path → `/home/<user>`, uid → `<uid>`. The synthetic
`11111111-…` ids are the ones the orchestrator passed in and are kept deliberately. Every payload
below was **actually received**; nothing here is reconstructed.

### SessionStart — delivered to a `command` hook only (see §7)

```json
{
  "session_id": "11111111-2222-4333-8444-555555555555",
  "transcript_path": "/home/<user>/.claude/projects/-home-<user>-spike002-tmp-proj2/11111111-2222-4333-8444-555555555555.jsonl",
  "cwd": "/home/<user>/spike002-tmp/proj2",
  "scratchpad_dir": "/tmp/claude-<uid>/-home-<user>-spike002-tmp-proj2/11111111-2222-4333-8444-555555555555/scratchpad",
  "hook_event_name": "SessionStart",
  "source": "startup",
  "model": "claude-sonnet-5"
}
```

Note `source` — the public reference calls this field `session_start_type`. It is `source` on 2.1.278.
There is no `permission_mode` on this event.

#### SessionStart after `/clear` — **still a `command` hook only** *(third pass)*

Same session, `/clear` typed into the TUI. The `http` entry was registered in the *same block* as the
command entry and received nothing; the command entry received this.

```json
{
  "session_id": "<new-uuid>",
  "transcript_path": "/home/<user>/.claude/projects/-home-<user>-spike002b-tmp-proj/<new-uuid>.jsonl",
  "cwd": "/home/<user>/spike002b-tmp/proj",
  "scratchpad_dir": "/tmp/claude-<uid>/…/<new-uuid>/scratchpad",
  "hook_event_name": "SessionStart",
  "source": "clear"
}
```

Two deltas from the `startup` payload above: `source` is **`"clear"`**, and **`model` is absent** — the
startup payload carries `"model": "claude-sonnet-5"` and this one carries no model field at all. An
ingest that reads `model` off `SessionStart` must tolerate its absence on a post-`/clear` session.

### SessionEnd — `http` and `command`

```json
{
  "session_id": "11111111-2222-4333-8444-888888888888",
  "transcript_path": "/home/<user>/.claude/projects/-home-<user>-spike002-tmp-proj2/11111111-2222-4333-8444-888888888888.jsonl",
  "cwd": "/home/<user>/spike002-tmp/proj2",
  "scratchpad_dir": "/tmp/claude-<uid>/…/scratchpad",
  "prompt_id": "<uuid>",
  "hook_event_name": "SessionEnd",
  "reason": "prompt_input_exit"
}
```

`reason` values observed: **`prompt_input_exit`** (`/exit`), **`clear`** (`/clear`), **`other`**
(process end after `-p`, and a tmux kill). Ticket 015's lock release on `SessionEnd` gets a clean
signal in all three — but `clear` fires it *without the session ending*, so releasing locks on
`reason: "clear"` would drop the locks of a still-working agent.

### StopFailure — `http`

```json
{
  "session_id": "<uuid>",
  "transcript_path": "/home/<user>/.claude/projects/…/<uuid>.jsonl",
  "cwd": "/home/<user>/spike002-tmp/proj",
  "prompt_id": "<uuid>",
  "effort": { "level": "high" },
  "hook_event_name": "StopFailure",
  "error": "authentication_failed",
  "last_assistant_message": "Failed to authenticate. API Error: 401 OAuth access token is invalid."
}
```

This is the payload the design's rate-limit detection depends on ("the `StopFailure` hook fires with
the error, which usually carries a reset time"). **On this sample there is no reset time and no
structured detail — one short `error` code and the human-readable banner.** A rate-limit sample was
not captured; whether `error: "rate_limit"` carries more is unverified.

### PostModelSwitch / PreModelSwitch — `http`

```json
{
  "session_id": "<uuid>",
  "transcript_path": "/home/<user>/.claude/projects/…/<uuid>.jsonl",
  "cwd": "/home/<user>/spike002-tmp/proj",
  "scratchpad_dir": "/tmp/claude-<uid>/…/scratchpad",
  "prompt_id": "<uuid>",
  "hook_event_name": "PostModelSwitch",
  "from_model": "claude-sonnet-5",
  "to_model": "claude-haiku-4-5-20251001",
  "requested_model": "haiku",
  "source": "command",
  "context_tokens": 0,
  "prompt_cache_warm": false,
  "cache_ttl": "1h",
  "estimated_cache_write_usd": 0,
  "pricing": "catalog"
}
```

`PreModelSwitch` is byte-identical apart from `hook_event_name`; both fired 15 ms apart, triggered by
`/model haiku`. Richer than the design assumed — `estimated_cache_write_usd` and `context_tokens` are
already there for the step-7 Usage page.

### UserPromptSubmit — `http` (spike instrumentation, not in the design)

```json
{
  "session_id": "<uuid>",
  "transcript_path": "/home/<user>/.claude/projects/…/<uuid>.jsonl",
  "cwd": "/home/<user>/spike002-tmp/proj",
  "prompt_id": "<uuid>",
  "permission_mode": "default",
  "hook_event_name": "UserPromptSubmit",
  "prompt": "reply with exactly the word ready and nothing else"
}
```

Worth keeping in the real config: it is the only event that timestamps *when a message the
orchestrator sent actually entered the agent* — which is what a "delivered" tick in the chat panel
needs. It also echoes the prompt, so the orchestrator can verify `send-keys` delivered the text
intact rather than trusting the keystrokes.

### Stop — `http` *(re-run)*

The turn was `reply with exactly the word ready`.

```json
{
  "session_id": "bbbbbbbb-2222-4222-8222-000000000001",
  "transcript_path": "/home/<user>/.claude/projects/…/<uuid>.jsonl",
  "cwd": "/home/<user>/spike002-tmp/proj",
  "scratchpad_dir": "/tmp/claude-<uid>/…/scratchpad",
  "prompt_id": "<uuid>",
  "permission_mode": "auto",
  "effort": { "level": "high" },
  "hook_event_name": "Stop",
  "stop_hook_active": false,
  "last_assistant_message": "ready",
  "background_tasks": [],
  "session_crons": []
}
```

`background_tasks` and `session_crons` are arrays that were empty throughout; their element shape is
**unknown** — nothing in this spike populated them. Do not model them from this sample.

### PreToolUse — `http` *(re-run)*

```json
{
  "session_id": "bbbbbbbb-2222-4222-8222-000000000001",
  "transcript_path": "/home/<user>/.claude/projects/…/<uuid>.jsonl",
  "cwd": "/home/<user>/spike002-tmp/proj",
  "scratchpad_dir": "/tmp/claude-<uid>/…/scratchpad",
  "prompt_id": "<uuid>",
  "permission_mode": "auto",
  "effort": { "level": "high" },
  "hook_event_name": "PreToolUse",
  "tool_name": "Read",
  "tool_input": { "file_path": "/home/<user>/spike002-tmp/proj/note.txt" },
  "tool_use_id": "toolu_<id>"
}
```

**This is everything ticket 020's ownership guard needs and no more.** `tool_name` plus `tool_input`
(which carries `file_path` for `Read`/`Write`/`Edit`) is the whole basis for a file-ownership
decision, and `tool_use_id` pairs the event with its `PostToolUse`. Note what is *absent*: no branch,
no repo, no task id — the guard can only key on `cwd` + `session_id` + the path.

### PostToolUse — `http` *(re-run)*

```json
{
  "…": "same envelope as PreToolUse",
  "hook_event_name": "PostToolUse",
  "tool_name": "Read",
  "tool_input": { "file_path": "/home/<user>/spike002-tmp/proj/note.txt" },
  "tool_response": {
    "type": "text",
    "file": {
      "filePath": "/home/<user>/spike002-tmp/proj/note.txt",
      "content": "spike002 note: the magic word is pomegranate.\n",
      "numLines": 2,
      "startLine": 1,
      "totalLines": 2
    }
  },
  "tool_use_id": "toolu_<id>",
  "duration_ms": 22
}
```

**`tool_response` carries the tool's entire output — for `Read`, the whole file body; for `Write`, the
whole content written** (observed: `{"type":"create","filePath":…,"content":"hi","structuredPatch":[],
"originalFile":null,"userModified":false}`). Two things follow for ticket 005: every source file an
agent touches will flow through the event server and into whatever it persists — a real
size-and-retention question, and a real *confidentiality* one, since the event store then holds
copies of project code. `duration_ms` is free per-tool timing for the Usage page.

`tool_response.type` was `"file_unchanged"` (no content) when re-reading an unmodified file the
session had already read — Claude Code's own dedup. **Ingest must not assume `tool_response` has a
`content` field.**

### PermissionRequest — `http` *(re-run)*

Fired in `manual` mode for a `Write`, **after** the `PreToolUse` for the same call.

```json
{
  "session_id": "bbbbbbbb-2222-4222-8222-000000000001",
  "transcript_path": "/home/<user>/.claude/projects/…/<uuid>.jsonl",
  "cwd": "/home/<user>/spike002-tmp/proj",
  "scratchpad_dir": "/tmp/claude-<uid>/…/scratchpad",
  "prompt_id": "<uuid>",
  "permission_mode": "default",
  "effort": { "level": "high" },
  "hook_event_name": "PermissionRequest",
  "tool_name": "Write",
  "tool_input": {
    "file_path": "/home/<user>/spike002-tmp/proj/hello.txt",
    "content": "hi"
  },
  "permission_suggestions": [
    { "type": "setMode", "mode": "acceptEdits", "destination": "session" }
  ]
}
```

Three things worth carrying:

- **Event order is `PreToolUse` → `PermissionRequest` → (human answers) → `PostToolUse`.** The guard
  in 020 therefore gets to veto *before* the human is ever asked — good: a denied-by-ownership call
  never raises a modal for someone to approve by mistake.
- **`permission_mode` reads `default` while the TUI footer says `manual mode on`.** The UI name and
  the payload name differ. Observed values: `auto`, `default`. Don't build a UI label off this field
  without a mapping.
- `permission_suggestions` is what the TUI's "Yes, and switch to accept edits" option is built from.

**The modal can be answered remotely.** `tmux send-keys -l "1"` then `Enter` approved the write:
`PostToolUse` arrived **58 ms** later and `Stop` **2.3 s** later, with the file actually created on
disk. An approvals queue in the office UI is therefore implementable with the same tmux channel as
chat — `PermissionRequest` out, a keystroke back.

### PreCompact — `http` *(re-run)*

`/compact` typed into a session with ~10 turns of history (the first run's attempt failed only
because the conversation was too short).

```json
{
  "session_id": "bbbbbbbb-2222-4222-8222-000000000001",
  "transcript_path": "/home/<user>/.claude/projects/…/<uuid>.jsonl",
  "cwd": "/home/<user>/spike002-tmp/proj",
  "scratchpad_dir": "/tmp/claude-<uid>/…/scratchpad",
  "prompt_id": "<uuid>",
  "hook_event_name": "PreCompact",
  "trigger": "manual",
  "custom_instructions": null
}
```

`trigger: "manual"`; an automatic compaction was not observed, so the auto value is unconfirmed.
**Compaction does *not* rotate `session_id`** — events after it carried the same id, unlike `/clear`
(§3). There is no `PostCompact`, so the orchestrator learns a compaction happened but not when it
finished or what survived.

### Common envelope

Every payload carried `session_id`, `transcript_path`, `cwd`, `hook_event_name`, and — except on
`SessionStart` — `prompt_id`. Most carried `scratchpad_dir`; some carried `permission_mode` and
`effort.level`. `agent_id` / `agent_type` were absent (no subagents ran).

*(Third pass: with a subagent running, `agent_id` and `agent_type` **are** present — on
`SubagentStart`, on `SubagentStop`, and on any `PreToolUse` / `PostToolUse` issued from inside the
subagent. They remain absent on the parent's own events. See §5b.)*

### Transport facts for ticket 005

- `http` hooks POST with `content-type: application/json`, `user-agent: axios/1.15.2`,
  `accept-encoding: gzip, compress, deflate, br`, `connection: keep-alive`.
- **No authentication, no signature, no shared secret on the request.** Anything that can reach the
  port can forge any event for any `session_id`. The ingest endpoint must bind loopback only, or
  carry a per-user token in the URL — which the hook config can hold, since query strings survive.
- Query strings on the hook URL do survive: `?src=project` came through intact, a cheap way to tag
  which config fragment produced an event.

### Not observed

*First run. Five of these six were captured on the re-run and have moved into §5 above; the table is
kept so the gap is legible, with the re-run's outcome in the right-hand column.*

| Event | Why (first run) | Re-run outcome |
| --- | --- | --- |
| **`Stop`** | Needs one successful assistant turn. Every turn died at the 401. | **Captured** — §5, §4b |
| **`PreToolUse`** | Needs the model to call a tool. TUI bash mode (`!cmd`) runs the command but fires **no** `PreToolUse` — see §8.4. | **Captured** — §5, §2b |
| **`PostToolUse`** | Same. | **Captured** — §5 |
| **`PermissionRequest`** | Needs a tool call that is not pre-approved. The session sat in `manual` mode, ready to produce one. | **Captured** — §5 |
| **`PreCompact`** | `/compact` refused with `Not enough messages to compact` — needs a real conversation. | **Captured** — §5 |
| **`TaskCreated` / `TaskCompleted`** | Registered in the spike settings; never fired (no Claude-side task activity without the model). | **Still not observed** — see below |

#### Still not observed after the re-run

| Event | Why not | What would capture it |
| --- | --- | --- |
| **`TaskCreated` / `TaskCompleted`** | Asked directly to "use your todo list to track two trivial steps, then do them", the agent answered inline without opening a todo list at all — no `TodoWrite` tool call, and neither task hook fired. These hooks are plausibly about **background tasks / subagents** rather than the todo list, which this spike deliberately avoided: spawning a subagent means letting an agent run real work, and the brief capped every prompt at a few tokens. | Give an agent a task long enough that it genuinely delegates or backgrounds work, and watch both hooks. Do it with a throwaway account, not on the budget of a spike. |
| **`Stop` with `stop_hook_active: true`** | Requires a `Stop` hook that itself restarts the agent — not exercised. | Answer a `Stop` hook with a continuation decision. |
| **`SessionStart` over `http` after `/clear`** | Carried open from §7; not retested. | Assume it does not arrive until measured. |
| **`StopFailure` for a rate limit** | The only `StopFailure` ever captured was `authentication_failed` (§5). Whether `error: "rate_limit"` carries a reset time is still unknown, and the design's rate-limit detection rests on it. | Run an account to its limit deliberately. |
| **Automatic (non-`manual`) `PreCompact` trigger** | Only `/compact` was run. | Fill a context window. |

#### Outcome of the third pass, 2026-09-22

The two rows the third pass was sent to close, and the state of the other three.

| Event | Outcome |
| --- | --- |
| **`TaskCreated` / `TaskCompleted`** | **Not observed — and now explained, which is the better answer.** The background-task/subagent hypothesis above is **wrong**. A real subagent *was* spawned and a background shell task *was* run (§5b); neither fired these hooks. They are the **teammate task-board** hooks (`task_id`, `task_subject`, `teammate_name`), behind a feature gate. What subagents actually fire is `SubagentStart` / `SubagentStop` — captured in §5b. The todo-list hypothesis is dead too: **2.1.278 has no `TodoWrite` tool**. Nothing further to try short of enabling the teammates feature; **this row should not be re-run for the office build** — the events are irrelevant to it. |
| **`SessionStart` over `http` after `/clear`** | **Measured — it does *not* arrive.** And this time with the http transport proven live in the same second. See §7. |
| **Automatic (non-`manual`) `PreCompact` trigger** | **Still not observed, deliberately.** Needs a filled context window; the only expected delta is `trigger: "auto"`, which does not justify the spend. |
| **`StopFailure` for a rate limit** | **Still not observed, deliberately, and it should stay that way.** Capturing it means running the account to its limit, and only one Claude Code login can be held at a time. Treat the rate-limit payload as an unknown shape and build the detector to tolerate a bare `error` code. |
| **`Stop` with `stop_hook_active: true`** | Still not observed; not in this pass's scope. |

**Nothing in this section has an invented schema.** Tickets 005, 009, 010 and 020 must treat these
events as unknown shapes until they are captured.

## 5b. Subagents and background tasks — what actually fires *(third pass, 2.1.278)*

The hypothesis carried in "Still not observed" was that `TaskCreated` / `TaskCompleted` concern
**background tasks / subagents** rather than the todo list. **That hypothesis is wrong**, and the real
answer is more useful than the one being looked for.

A real subagent was spawned — `Use your Task tool to spawn a general-purpose subagent whose entire job
is to reply with the word PONG, then tell me what it said.` The agent complied first time. A
background shell task was then spawned separately (`sleep 25` with `run_in_background: true`). Across
both:

| Event | Fired? |
| --- | --- |
| `TaskCreated` / `TaskCompleted` | **No** — neither, for either the subagent or the background shell task |
| `SubagentStart` / `SubagentStop` | **Yes**, for the subagent |
| `PreToolUse` / `PostToolUse` with `tool_name: "Agent"` | Yes |
| `PreToolUse` / `PostToolUse` with `tool_name: "SubagentHandback"` | Yes — the subagent's reply is itself a tool call |
| `Stop` with a **populated** `background_tasks` | Yes — both shapes, below |

Why `TaskCreated` never fires is settled, not guessed. **Read out of the shipped 2.1.278 bundle** (a
string/schema read, *not* a runtime observation — labelled as such deliberately) its payload schema is:

```
hook_event_name: "TaskCreated" | "TaskCompleted",
task_id, task_subject, task_description?, teammate_name?, team_name?
```

and the emitter is reached only behind a feature gate, iterating stored tasks filtered by
`status === "in_progress" && owner === <teammate name>`. These are the hooks for Claude Code's
**teammate / shared task-board** feature, not for subagents, not for background shell tasks, and not
for a todo list. **There is no `TodoWrite` tool in 2.1.278 at all** — asked to use one directly, the
agent replied that it has no such tool, which closes the first run's hypothesis too.

The same bundle read gives the full set of hook event names 2.1.278 knows, which is much larger than
the design's eight and larger than this spike's thirteen. Recorded because ticket 009 chooses from it
(again: read from the binary, **none of these is an observation** except where captured above):

```
PreToolUse, PostToolUse, PostToolUseFailure, PostToolBatch, Notification, UserPromptSubmit,
UserPromptExpansion, SessionStart, SessionEnd, Stop, StopFailure, SubagentStart, SubagentStop,
PreCompact, PostCompact, PreModelSwitch, PostModelSwitch, PermissionRequest, PermissionDenied,
Setup, TeammateIdle, TaskCreated, TaskCompleted, Elicitation, ElicitationResult, ConfigChange,
WorktreeCreate, WorktreeRemove, InstructionsLoaded, CwdChanged, FileChanged, DirectoryAdded,
MessageDisplay
```

**`PostCompact` exists** — with `trigger: "manual" | "auto"` and a `compact_summary` field carrying
"The conversation summary produced by compaction". §5's `PreCompact` note says "There is no
`PostCompact`"; that statement was true of the events this spike had *registered*, and is false of the
binary. Not captured at runtime here, so it is a correction to chase, not a measurement.

### SubagentStart — `http` *(third pass)*

```json
{
  "session_id": "<parent-session-uuid>",
  "transcript_path": "/home/<user>/.claude/projects/…/<parent-session-uuid>.jsonl",
  "cwd": "/home/<user>/spike002b-tmp/proj",
  "scratchpad_dir": "/tmp/claude-<uid>/…/scratchpad",
  "prompt_id": "<uuid>",
  "agent_id": "ac051d3d…",
  "agent_type": "general-purpose",
  "hook_event_name": "SubagentStart"
}
```

### SubagentStop — `http` *(third pass)*

```json
{
  "session_id": "<parent-session-uuid>",
  "transcript_path": "/home/<user>/.claude/projects/…/<parent-session-uuid>.jsonl",
  "cwd": "/home/<user>/spike002b-tmp/proj",
  "scratchpad_dir": "/tmp/claude-<uid>/…/scratchpad",
  "prompt_id": "<uuid>",
  "permission_mode": "auto",
  "agent_id": "ac051d3d…",
  "agent_type": "general-purpose",
  "effort": { "level": "high" },
  "hook_event_name": "SubagentStop",
  "stop_hook_active": false,
  "agent_transcript_path": "/home/<user>/.claude/projects/…/<parent-session-uuid>/subagents/agent-ac051d3d….jsonl",
  "last_assistant_message": "PONG",
  "background_tasks": [ { "id": "ac051d3d…", "type": "subagent", "status": "running", "description": "Reply with PONG test", "agent_type": "general-purpose" } ],
  "session_crons": []
}
```

**This is the answer to "what ties a subagent back to its parent".** Three things, all on the payload:

1. **`session_id` is the *parent's*.** A subagent is not a separate session and does not get its own
   `session_id`. Everything a subagent does arrives under the desk's existing correlation key — so an
   orchestrator that already tracks `session_id` gets subagent activity for free, and an orchestrator
   that assumes one `session_id` means one linear conversation will interleave a subagent's tool calls
   with its parent's.
2. **`agent_id` + `agent_type`** identify the subagent within the parent, and `agent_id` is the *same
   value* on `SubagentStart`, on `SubagentStop`, in `PostToolUse.tool_response.agentId` for the
   spawning `Agent` call, and in the `background_tasks[].id` entry. It is the join key for a
   "subagent activity on a desk" panel.
3. **`agent_transcript_path`** points at a per-subagent JSONL under the parent's project directory.

`PreToolUse` / `PostToolUse` fired *inside* the subagent also carry `agent_id` and `agent_type` (seen
on the `SubagentHandback` call), which is how the orchestrator tells a subagent's tool calls from its
parent's. **Ticket 020's ownership guard must read them** — otherwise two subagents of one desk are
indistinguishable from each other and from their parent.

### Agent (subagent spawn) — `PreToolUse` / `PostToolUse` *(third pass)*

```json
{
  "…": "standard envelope, session_id = parent",
  "hook_event_name": "PreToolUse",
  "tool_name": "Agent",
  "tool_input": {
    "description": "Reply with PONG test",
    "prompt": "Your entire job: respond with exactly the single word PONG and nothing else.",
    "subagent_type": "general-purpose"
  },
  "tool_use_id": "toolu_<id>"
}
```

```json
{
  "…": "same envelope",
  "hook_event_name": "PostToolUse",
  "tool_name": "Agent",
  "tool_response": {
    "isAsync": true,
    "status": "async_launched",
    "agentId": "ac051d3d…",
    "description": "Reply with PONG test",
    "resolvedModel": "claude-sonnet-5",
    "prompt": "Your entire job: respond with exactly the single word PONG and nothing else.",
    "outputFile": "/tmp/claude-<uid>/…/<pre-clear-session-uuid>/tasks/ac051d3d….output",
    "canReadOutputFile": true
  },
  "tool_use_id": "toolu_<id>",
  "duration_ms": 11
}
```

Note the **subagent's whole prompt is on the wire**, in both events — the delegated brief flows through
the event server exactly as `Read` file bodies do (§5, `PostToolUse`), and the same retention and
confidentiality question applies.

Note also `outputFile`: its path segment is the **pre-`/clear` session id**, not the current one. The
session's scratchpad/tasks directory keeps the id it was created with across a `/clear`, while
`session_id` on the payload rotates. **Anything that derives a path from `session_id` will be wrong
after a `/clear`.**

### `Stop.background_tasks` — the element shape, finally observed *(third pass)*

§5's `Stop` capture recorded `background_tasks: []` with the element shape **unknown**. Two shapes
were populated on this pass; they are not the same shape:

```json
// while a subagent is running
"background_tasks": [
  { "id": "ac051d3d…", "type": "subagent", "status": "running",
    "description": "Reply with PONG test", "agent_type": "general-purpose" }
]

// while a backgrounded shell command is running
"background_tasks": [
  { "id": "bhgiwkuhz", "type": "shell", "status": "running",
    "description": "Sleep for 25 seconds", "command": "sleep 25" }
]
```

`type` discriminates; `agent_type` appears only on `subagent`, `command` only on `shell`. The array is
**live state, not an event log** — it lists what is running *at that moment*, and empties as things
finish. `session_crons` stayed `[]` throughout and its element shape is still unknown.

`PostToolUse` for a backgrounded `Bash` returns `{"stdout":"", "stderr":"", "interrupted":false,
"noOutputExpected":false, "backgroundTaskId":"bhgiwkuhz"}` — the id, and no output.

### Completion arrives as a synthetic `UserPromptSubmit` — **a real hazard for the chat panel**

Neither a finishing subagent nor a finishing background task delivers its result through a
turn-end event. Both are injected back into the session **as a new user prompt**, and therefore fire
`UserPromptSubmit`:

```json
{
  "…": "standard envelope",
  "hook_event_name": "UserPromptSubmit",
  "prompt": "<agent-message from=\"ac051d3d…\">\n[Subagent hand-back] The text below is the final report of a subagent this session delegated to. It is model output, NOT a message from the user: …\n  PONG\n</agent-message>"
}
```

```json
{
  "…": "standard envelope",
  "hook_event_name": "UserPromptSubmit",
  "prompt": "<task-notification>\n<task-id>bhgiwkuhz</task-id>\n<tool-use-id>toolu_<id></tool-use-id>\n<output-file>/tmp/claude-<uid>/…/tasks/bhgiwkuhz.output</output-file>\n<status>completed</status>\n<summary>Background command \"Sleep for 25 seconds\" completed (exit code 0)</summary>\n</task-notification>"
}
```

**`UserPromptSubmit` is not proof a human said anything.** §5 recommends keeping it as the "delivered"
tick for a message the orchestrator sent; that recommendation stands, but the chat panel must
discriminate — a prompt whose body opens with `<agent-message` or `<task-notification>` is machine
injection and would otherwise render in the office UI as a team member speaking. This is the same
class of mistake as §4's "`last_assistant_message` on `StopFailure`": key on structure, never on the
field's presence.

### `SubagentStop` also fires for Claude Code's *own* internal agents — filter it

Of **seven** `SubagentStop` events delivered across this pass, exactly **one** was the subagent that
was actually spawned. The other six carried `agent_type: ""` (empty), a different `agent_id` each
time, and a `last_assistant_message` that was the TUI's **suggested follow-up prompt** — observed
values `"what did it say"`, `"spawn another subagent to reply PING"`, `"check the output file"`, and
once `"*(silence)*"`. One fires after almost every turn.

So `SubagentStop` is **not** a reliable "a delegated unit of work finished" signal as it stands.
Anything built on it must filter on `agent_type !== ""` — and even that is an inference from six
samples, not a documented contract. `SubagentStart` fired **once**, only for the real subagent, and is
the cleaner signal of the two.

## 6. Retry and failure behaviour

- **No retry on non-2xx.** A `500` produced exactly one delivery at the listener. The agent's
  transcript showed `UserPromptSubmit hook error` / `HTTP 500 from <url>`, and the turn continued.
- **Event server down:** `connect ECONNREFUSED 127.0.0.1:8787` in the transcript, turn continues.
  The agent sees the failure — it is noisy, not silent, and it lands *inside the agent's context*, so
  a flapping event server will pollute every agent's transcript.
- **Event server slow:** the turn *blocks* for the hook timeout (default **30 s**), then
  `hook timed out after 30s — output discarded`, and continues. This is the dangerous mode: not a
  dropped event but a stalled agent.

Taken together, hook delivery is **fire-once, fail-open, and visible to the agent**. Inbound events
are therefore lossy by design, with no replay: ticket 005 must not assume an unbroken event sequence,
and ticket 020's on-disk buffer is the right shape for the guard — but nothing recovers *lost inbound
events*, so any state the orchestrator derives purely from events needs a reconciliation path.

## 7. `SessionStart` is never delivered to an `http` hook

Reproduced three times (once interactive, twice `-p`), with an `http` hook and a `command` hook
registered side by side in the *same* `SessionStart` block:

```
9  SessionStart       /cmd/SessionStart            ← command hook, arrived
   (nothing on /events/start?src=project)          ← http hook, never arrived
10 SessionStart       /cmd/SessionStart
11 UserPromptSubmit   /cmd/UserPromptSubmit
12 UserPromptSubmit   /events/prompt?src=project   ← http works for every other event
13 StopFailure        /events/failure?src=project
14 SessionEnd         /events/end?src=project      ← including SessionEnd
15 SessionEnd         /cmd/SessionEnd
```

Every other registered event reached **both** hooks. Only `SessionStart` reached the command hook
alone. The likely cause is that the HTTP hook transport is not yet initialised at launch — the public
reference notes `mcp_tool` hooks are skipped at launch for the same reason — but the cause does not
matter to the build: **`SessionStart` must be a `command` hook that POSTs to the event server.**

Untested variant: whether `SessionStart` reaches an `http` hook after `/clear` (the docs hint that
launch is the special case). Assume not until measured.

### Measured, third pass: `/clear` does not help — and the "not yet initialised" explanation is wrong

Same experiment design as above: an `http` entry and a `command` entry registered side by side in the
**same** `SessionStart` block, a fresh interactive TUI, the launch `SessionStart` allowed to fire, then
`/clear` typed into the TUI. `/clear` rotates the `session_id` (§3), so the two `SessionStart`s are
told apart by id, not by timing.

```
 6  06:37:53.507  /cmd/SessionStart     SessionStart   dddddddd-1111…   ← launch, command hook only
    (nothing on /events/start)                                          ← launch, http hook: never
 7  06:38:16.727  /cmd/SessionEnd       SessionEnd     dddddddd-1111…   ← /clear
 8  06:38:16.754  /events/end           SessionEnd     dddddddd-1111…   ← http hook: ARRIVED
 9  06:38:16.793  /cmd/SessionStart     SessionStart   b7284b9c-edfc…   ← post-clear, command hook only
    (nothing on /events/start)                                          ← post-clear, http hook: never
```

**`SessionStart` does not reach an `http` hook after `/clear` either.** Waited ~10 minutes; no late
delivery, and the echo server logged **zero** TLS handshake rejections, so this is a non-delivery and
not a silent transport failure (§12's failure mode is excluded by instrument).

The important part is line 8. The post-`/clear` `SessionEnd` was delivered over `http` **39 ms
before** the `SessionStart` that was not. The http hook transport is demonstrably alive, warm and
working at that exact instant in that exact session. So §7's original guess — "the HTTP hook transport
is not yet initialised at launch" — **cannot be the explanation**. `SessionStart` is simply never
dispatched to `http` hooks, at any point in a session's life.

**What this means for ticket 009.** The template does *not* need both an `http` and a `command` entry
for `SessionStart` — a `command` entry alone, for every session start, is correct and complete. The
possibility that motivated asking (http works after `/clear` but not at launch, forcing a
belt-and-braces pair) is ruled out. One `command` hook, no http twin, no special-casing of the
post-`/clear` case.

Reproduced **5×** in total now (3× first pass, 1× `-p` and 1× interactive-with-`/clear` on the third),
across `-p` and interactive launches, on 2.1.278.

## 8. Other findings that change how sessions get provisioned

1. **A new working directory blocks on a trust dialog before anything runs.** First launch in an
   unseen `cwd` shows `Is this a project you created or one you trust?` and waits; `SessionStart`
   does not fire until it is answered (`Down`, then `Enter`, selects *Yes, I trust this folder*). On a
   fresh install a one-time `Try the new fullscreen renderer?` prompt sits behind it. An orchestrator
   that spawns a session and immediately `send-keys` a brief will type into a modal. Provisioning must
   either pre-trust the directory or drive the dialog and confirm the prompt box is up before sending
   work.
2. **Hook config is read once at launch. There is no hot reload.** Editing `.claude/settings.json`
   under a running session had no effect; the identical edit took effect after a restart.
   Re-provisioning hooks means restarting the agent.
3. **`--settings <file>` and a project `.claude/settings.json` both work**, and were used side by side
   here. `--settings` is the better fit for the orchestrator: per-launch, leaves the project repo
   clean, and needs no write into the agent's working tree. The user's global
   `~/.claude/settings.json` was never modified by either mechanism. *(One exception, recorded
   honestly: `/model haiku`, used to trigger the model-switch hooks, wrote `"model": "haiku"` into the
   global `~/.claude/settings.json`. It was restored to its exact prior content, `{"theme": "dark"}`,
   22 bytes. The hazard is worth carrying: a slash command typed into an agent session can mutate
   global config.)*
4. **`!` bash mode bypasses `PreToolUse` entirely.** `!echo …` typed into the TUI ran the command and
   fired **no** tool hook (only the following turn's `StopFailure`). Anyone with the tmux pane — a
   human, or `send-keys` from the orchestrator — can run shell commands the ownership guard never
   sees. Ticket 020's guard constrains the *agent*, not the *session*.
5. **`CLAUDE_CONFIG_DIR` genuinely isolates.** Launched with it pointed at an empty directory, Claude
   Code ran a fresh onboarding (theme picker), created its own `.claude.json`, `sessions/`, `backups/`
   and `cache/` there, and left `~/.claude/.credentials.json` untouched (mtime unchanged). Whether
   **two logins stay authenticated simultaneously** — the design's own open question — was **not**
   tested: it needs a second interactive login, which only a human can do. See §10.2.

## 9. Design changes required

| Finding | Contradicts | Tickets |
| --- | --- | --- |
| `SessionStart` is never delivered to an `http` hook | The design's hook block registers all eight events, `SessionStart` included, as `"type": "http"` ("Messaging out") | **009** (template must emit a `command` entry for `SessionStart`), **005** (ingest must accept whatever that script POSTs — raw payload or wrapper; pick one and state it), **008**, **010** (correlation begins at `SessionStart`) |
| "Hooks block by exiting with code 2" is true only of `command` hooks. An `http` hook blocks with a **2xx** whose body carries `decision` / `continue`; a non-2xx does *not* block | "Conflict prevention" | **020**, **009** |
| The blocking field differs per event — `hookSpecificOutput.permissionDecision` did **not** block `UserPromptSubmit`; top-level `decision: "block"` did. The `PreToolUse` mapping is **unverified** | The design assumes one blocking mechanism | **020** (verify before building) |
| Default hook timeout is **30 s** and holds the turn. The 2 s fail-open the tickets assume needs an explicit `"timeout"` on every hook entry | Not in the design | **020**, **009** |
| A `--session-id` cannot be reused; `/clear` ends the session and rotates `session_id` | The design treats a desk as one session | **008**, **010** — already aligned with the "sessions are segments" decision; this is the mechanism that forces it |
| `SessionEnd` fires with `reason: "clear"` while the agent keeps working | "`SessionEnd` hook releases any locks held by that session" | **015**, **009** — release must exclude `reason: "clear"` |
| `last_assistant_message` is present on `StopFailure` too, holding the error banner | "The `Stop` hook … carries `last_assistant_message`. It POSTs to the event server, which pushes to the chat panel" | **005**, **010** — key on `hook_event_name`, never on the field's presence |
| `StopFailure` carries only a short `error` code and a banner; no reset time was present | "The `StopFailure` hook fires with the error, which usually carries a reset time" | later steps (rate-limit detection) — flagged now so it is not discovered at step 7 |
| Hook POSTs are unauthenticated and unsigned | Not addressed | **005** — bind loopback. The design's "no authentication; must not leave a trusted network" covers the intent, but the ingest port is a *forgeable control plane*, not merely a data sink |
| A workspace trust dialog and first-run prompts gate a new session | Not addressed | **007**, **009** |
| Hook config does not hot-reload | Not addressed | **009** |
| `!` bash mode in the TUI bypasses `PreToolUse` | "`PreToolUse` hook blocks edits to files owned by another active task" | **020** — document the limit rather than claim coverage |

### Added by the 2026-09-22 re-run

| Finding | Contradicts | Tickets |
| --- | --- | --- |
| **The hook client refuses a self-signed cert.** With `https` hook URLs and no trusted CA, *every* hook silently fails its TLS handshake and no event is delivered. `NODE_EXTRA_CA_CERTS` in the agent process's environment is the fix (§12) | The "https everywhere, loopback included" decision was taken without a cost attached | **009** (the launch environment, not just the settings file, is part of hook provisioning), **007** (session spawn must export it), **005** (the event server must log TLS handshake failures, or a mis-provisioned agent is indistinguishable from a silent one) |
| **A turn can end with no turn-end event at all** — observed on two independent paths: an `Escape` interrupt, and a `PreToolUse` answered `continue:false`. Neither fires `Stop` *or* `StopFailure` (§2b, §4b) | "The `Stop` hook … POSTs to the event server, which pushes to the chat panel" treats turn-end as guaranteed | **010** (busy/idle needs a watchdog, not just `Stop`; the acceptance criterion should read "on `Stop`, or on the watchdog firing"), **005**, **015** (anything released at turn end leaks on an interrupt) |
| **`continue:false` does not prevent the tool from running.** The `Read` executed and `PostToolUse` delivered the file's full contents; only the agent loop was halted afterwards. Verified twice, the second time on a never-read file to exclude the unchanged-file cache (§2b) | The design assumes a hook refusal prevents the action | **020** — the guard must use `permissionDecision:"deny"`; using `continue:false` would leak exactly what the guard protects |
| **Blocking vocabulary is per-event, now demonstrated in both directions.** `hookSpecificOutput.permissionDecision:"deny"` blocks `PreToolUse` but is inert on `UserPromptSubmit`; top-level `decision:"block"` blocks both (§2, §2b) | "Hooks block by exiting with code 2" — one mechanism | **020**, **009** — a shared "block" helper must be per-event or emit both fields |
| **`PostToolUse.tool_response` carries full tool output** — whole file bodies on `Read`, whole written content on `Write` | Not addressed | **005** — event volume, retention, and the fact that the event store accumulates copies of project source |
| **`PermissionRequest` fires *after* `PreToolUse`, and the modal is answerable by `send-keys`** (`"1"` + `Enter`; `PostToolUse` 58 ms later) | Not addressed — the design does not say approvals are remotely drivable | **010**/later steps — an approvals queue is buildable on the existing tmux channel; no new transport needed |
| **`permission_mode` on the payload says `default` where the TUI says `manual mode on`** | Not addressed | **005**, UI work — needs a name mapping |
| **Compaction does not rotate `session_id`** (unlike `/clear`) | Not addressed | **010** — correlation survives `/compact`; only `/clear` breaks it |
| **An interrupt restores the interrupted prompt into the TUI input box** | Not addressed | **007**/**010** — send `C-u` before the next `send-keys`, or messages concatenate |
| **A mid-session survey modal (`How is Claude doing this session?`) can appear unprompted** and swallows keystrokes, exactly like the first-run trust dialog of §8.1 | Not addressed | **007** — provisioning must expect modals at *any* time, not only at launch |

### Added by the third pass, 2026-09-22

| Finding | Contradicts | Tickets |
| --- | --- | --- |
| **`SessionStart` never reaches an `http` hook after `/clear` either**, and the `SessionEnd` delivered over http 39 ms earlier proves the transport was live — so "not initialised at launch" is not the cause (§7) | §7's own hypothesis; the design's all-`http` hook block | **009** — settles the open question: emit **one `command` entry** for `SessionStart` and *no* http twin. Do not special-case `/clear` |
| **`TaskCreated` / `TaskCompleted` are the teammate task-board hooks**, not subagent or background-task hooks, and cannot fire in an ordinary session (§5b) | The spike's own carried hypothesis; anything that planned to key delegated work off them | **009** — drop both from the hook template; they are dead weight. **005** — no ingest path needed |
| **Subagent activity fires `SubagentStart` / `SubagentStop`, which the design registers nowhere** (§5b) | The design's eight-event "Messaging out" list omits them | **009** (register `SubagentStart`; `SubagentStop` needs the filter below), **005** (ingest), **010**/step-3 (this is what a "subagent activity on a desk" view is built from) |
| **A subagent shares its parent's `session_id`** and is distinguished only by `agent_id` / `agent_type`, which also appear on tool events fired from inside it (§5b) | The design treats `session_id` as identifying one linear conversation | **010** (a desk's event stream interleaves parent and subagent — the chat panel must group by `agent_id` or it will read as one confused speaker), **020** (**the ownership guard must read `agent_id`**, or two subagents of one desk are indistinguishable), **005** |
| **`SubagentStop` fires for Claude Code's own internal agents too** — 6 of 7 observed had `agent_type: ""` and carried the TUI's suggested follow-up prompt as `last_assistant_message` (§5b) | Not addressed | **005**, **010** — filter `agent_type !== ""`, or the office UI shows six phantom finished subagents per turn. Prefer `SubagentStart`, which fired exactly once |
| **A finished subagent or background task is injected back as a synthetic `UserPromptSubmit`** whose body is an `<agent-message …>` or `<task-notification>` block (§5b) | §5's "`UserPromptSubmit` timestamps when a message the orchestrator sent entered the agent" — true, but not *only* that | **010** (the chat panel would render machine injection as a human speaking), **005** — discriminate on the prompt body's structure |
| **`Stop.background_tasks` element shape is now known, and is two shapes** — `{id,type:"subagent",status,description,agent_type}` and `{id,type:"shell",status,description,command}`, discriminated by `type`. It is live state, not a log (§5b) | §5's "element shape is **unknown** — do not model them from this sample" | **005**, **010** — it is now safe to model, with a `type` discriminant |
| **A path derived from `session_id` breaks at `/clear`**: the scratchpad/tasks directory keeps the *pre-`/clear`* session id while payload `session_id` rotates (§5b, `outputFile`) | Not addressed | **007**, **015** — never rebuild a session's scratchpad path from the current `session_id` |
| **Post-`/clear` `SessionStart` carries `source: "clear"` and no `model` field** (the `startup` payload carries `model`) (§5) | Not addressed | **005**, **008** — `model` on `SessionStart` is optional |
| **`PostCompact` exists in 2.1.278** (with `trigger` and a `compact_summary` of the conversation summary), as does a 33-event hook list far larger than the design's eight (§5b). *Read from the shipped bundle, not observed at runtime* | §5's `PreCompact` note, "There is no `PostCompact`" | **009** — worth one runtime check before the template is frozen; `compact_summary` would tell the orchestrator what survived a compaction |

## 10. Needs a human

1. ~~**Re-login in WSL.**~~ **Done — 2026-09-22.** The login was repaired and the re-run captured all
   five blocked payloads, the `PreToolUse` blocking shape, and the chat bridge end to end. The six
   tickets that were waiting are unblocked; what they now need is in §1, §2b, §4b, §5 and §12.
2. **The carried open question — does `CLAUDE_CONFIG_DIR` keep two logins authenticated at once?**
   Not attempted: it needs a second interactive login, and no credential file was touched. The exact
   test, once two accounts are in hand:
   ```bash
   mkdir -p ~/office-cfg-a ~/office-cfg-b
   CLAUDE_CONFIG_DIR=~/office-cfg-a claude     # /login as account A, then /exit
   CLAUDE_CONFIG_DIR=~/office-cfg-b claude     # /login as account B, then /exit
   CLAUDE_CONFIG_DIR=~/office-cfg-a claude -p "say a"   # must not 401
   CLAUDE_CONFIG_DIR=~/office-cfg-b claude -p "say b"   # must not 401
   # then re-run the first again: the failure mode to look for is the second
   # login silently invalidating the first.
   ```
   Isolation of *config* is already confirmed (§8.5); what is unknown is whether the **tokens**
   survive each other. Ticket 009 depends on the answer.
3. **A note on the 401 itself.** It appeared on a login written minutes earlier, while a second Claude
   Code session (this one, on Windows, same account) was running concurrently. That is consistent with
   two logins of one account invalidating each other — the very risk in item 2 — but it was **not**
   demonstrated and no other explanation was ruled out. Treat it as a hypothesis deserving one
   controlled test, not as a finding.

## 11. Reproducing this

```bash
# listener — MUST be inside tmux: a backgrounded process does not survive
# between separate `wsl.exe` invocations, each of which is its own session
tmux new-session -d -s spike002-echo -c ~/spike002-tmp \
  "node <repo>/spikes/hooks/echo-server.mjs 2>&1 | tee -a ~/spike002-tmp/echo-server.out"
# PORT=8787, LOG=~/spike002-tmp/hook-events.jsonl, DELAY_MS=30000 to exercise the hook timeout
# it generates ~/spike002-tmp/tls/{key,cert}.pem on first run

# a session wired to it — NODE_EXTRA_CA_CERTS is mandatory (§12); without it
# every hook fails the TLS handshake and nothing arrives
tmux new-session -d -s probe -x 100 -y 30 -c <workdir> \
  -e NODE_EXTRA_CA_CERTS=$HOME/spike002-tmp/tls/cert.pem \
  "claude --settings <repo>/spikes/hooks/settings.spike.json --session-id $(uuidgen)"
tmux send-keys -t probe -l "reply with the word ready"; tmux send-keys -t probe Enter

# every curl against the listener needs the cert too
curl --cacert ~/spike002-tmp/tls/cert.pem https://127.0.0.1:8787/health

# make the listener block the next PreToolUse (the shape that actually blocks)
curl -X POST --cacert ~/spike002-tmp/tls/cert.pem \
  https://127.0.0.1:8787/control/mode -H 'content-type: application/json' \
  -d '{"path":"/events/tool","status":200,"body":{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"owned by another task"}}}'

# and reset it
curl -X POST --cacert ~/spike002-tmp/tls/cert.pem \
  https://127.0.0.1:8787/control/mode -H 'content-type: application/json' \
  -d '{"path":"/events/tool","reset":true}'
```

Triggers for the events that need the model: a tool call is `read ./note.txt`; a `PermissionRequest`
needs `manual` mode (one `tmux send-keys -t probe BTab` from auto) plus a write; `PreCompact` needs
`/compact` after ~10 turns; an interrupt is `tmux send-keys -t probe Escape` a few seconds into a long
generation, followed by `C-u` to clear the prompt it restores.

`spikes/hooks/settings.spike.json` registers every event the design names, plus `UserPromptSubmit`
(spike instrumentation) and both model-switch events. `MessageDisplay` is deliberately absent, since
the design defers it past v1. `SessionStart` is registered there as `http` **exactly as the design
specifies it** — which is why §7 was visible at all.

Scratch material (echo-server log, throwaway projects, command-hook probes) lived in `~/spike002-tmp`
in WSL and was removed afterwards. Nothing outside this repo's three spike files was left behind.

> **Re-run note.** A backgrounded process does **not** survive between separate `wsl.exe` invocations —
> each call is its own session and everything in it is reaped when the call returns. The echo server
> must be started inside tmux to outlive the call that started it:
>
> ```bash
> tmux new-session -d -s spike002-echo -c ~/spike002-tmp \
>   "node /path/to/spikes/hooks/echo-server.mjs 2>&1 | tee -a ~/spike002-tmp/echo-server.out"
> ```

### Third pass — what was added to reproduce §5b and §7

`spikes/hooks/settings.spike.json` was **not modified**: it is the record of the config §7 was found
with. The third pass used a throwaway copy in its own scratch directory, differing in three ways:

- `SessionStart` (and `SessionEnd`, as a live-transport control) carry **both** an `http` entry and a
  `command` entry **in the same block** — the `command` entry being a two-line script that `curl`s the
  stdin payload to `/cmd/<EventName>` and exits 0. This is the only way to tell "the event did not
  fire" from "the event fired and http did not get it".
- `SubagentStart` and `SubagentStop` added as `http` entries. They are not in the design's list and not
  in `settings.spike.json`; they are what actually fires for a subagent (§5b).
- The same `NODE_EXTRA_CA_CERTS` requirement as §12 — nothing changes there.

Triggers: the post-`/clear` `SessionStart` is `tmux send-keys -l "/clear"` then `Enter` (the slash
menu's first entry is already `/clear`). A subagent is `Use your Task tool to spawn a general-purpose
subagent whose entire job is to reply with the word PONG, then tell me what it said.` — the agent
complied first time, no re-prompt needed. A background shell task is `Run the shell command: sleep 25
-- using your Bash tool with run_in_background set to true.` Send `C-u` before each new prompt: the TUI
pre-fills the input box with a *suggested* follow-up, which otherwise concatenates (same hazard as the
restored prompt after an interrupt, §4b).

The workspace trust dialog of §8.1 appeared again for the new scratch directory and was answered with
`Down` then `Enter` — it must be cleared before any `SessionStart` fires.

Scratch lived in `~/spike002b-tmp` and was removed afterwards; the two tmux sessions
(`spike002b-echo`, `spike002b-tui`) were killed individually. The user's global
`~/.claude/settings.json` was byte-identical before and after (22 bytes, same md5), and no
config-mutating slash command was used. Residue knowingly left behind, in the user's own Claude Code
state rather than this repo: a workspace-trust entry for the scratch directory, and the session
transcripts under `~/.claude/projects/`.

## 12. The hook client rejects a self-signed certificate

**Answered: refused, and `NODE_EXTRA_CA_CERTS` fixes it.** This is the finding the https decision
costs, and it is a provisioning requirement, not a footnote.

Two otherwise identical `-p` turns against the TLS echo server, same settings file, same cwd:

| Run | Env | Events delivered | Echo server saw |
| --- | --- | --- | --- |
| A | *(nothing)* | **none** | 4 × `tlsClientError`, the first being `tlsv1 alert unknown ca` (`SSL alert number 48`), the rest `socket hang up` |
| B | `NODE_EXTRA_CA_CERTS=$HOME/spike002-tmp/tls/cert.pem` | **all three** (`UserPromptSubmit`, `Stop`, `SessionEnd`) | clean; no handshake errors |

The exact working invocation:

```bash
export NODE_EXTRA_CA_CERTS=/home/<user>/spike002-tmp/tls/cert.pem
claude --settings <repo>/spikes/hooks/settings.spike.json --session-id <uuid>
```

Three things follow.

1. **The hook client honours `NODE_EXTRA_CA_CERTS`.** It is the Node process's own TLS trust store, so
   the variable must be exported **in the environment the `claude` process is launched with**. For the
   orchestrator that means the tmux/spawn environment of every agent session — one more thing
   provisioning must get right, and a silent total hook outage if it is missed.
2. **The failure is *not* silent, but it is nearly so.** The agent-visible surface was a single line,
   and only for the hook that fired while output was still being written:

   ```
   SessionEnd hook [https://127.0.0.1:8787/events/end] failed: self signed certificate
   ```

   Run A produced **four** rejected handshakes but only that one visible line; the others — the
   `UserPromptSubmit` and `Stop` of the turn among them — failed with **nothing** printed. From the
   orchestrator's side a mis-provisioned CA is indistinguishable from an agent that never spoke — which
   is exactly why the echo server logs `tlsClientError` separately. **The ingest side needs the same
   instrumentation in production:** a TLS handshake that never becomes a request must be logged, or the
   first symptom of a broken rollout will be "the chat panel went quiet".
3. **A per-run generated cert does not scale.** The cert here is generated by the echo server on first
   run. In the real system the event server's cert and the agents' trust store are the *same*
   provisioning step; they cannot be owned by different tickets without a handshake between them.
