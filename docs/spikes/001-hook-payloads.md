# Spike 001 — Claude Code hook payloads and blocking semantics

**Ticket:** [002](../tasks/002-spike-hook-payloads.md) · **Department:** research · **Observed:** 2026-09-21/22

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

## Verdict, in one table

| Question | Answer | Confidence |
| --- | --- | --- |
| Chat bridge end to end (send-keys → agent → `Stop` → listener) | **Not proven.** The inbound half works and is measured; the model half could not run — the WSL Claude Code login returns `401 OAuth access token is invalid`. | blocked, see §1 |
| Can an `http` hook block? | **Yes** — verified on `UserPromptSubmit`. A `200` whose body is `{"decision":"block","reason":"…"}` blocks and feeds the reason back to the agent. **`PreToolUse` itself is unverified** (needs a real tool call, needs the model). | high for the mechanism, **unverified for PreToolUse** |
| Does a `command` hook exit 2 block, and can it reach the event server first? | **Yes**, both verified. | high |
| Correlation field | **`session_id`**, on every payload, including the *first* `SessionStart`. The orchestrator can choose it: `claude --session-id <uuid>` works on an interactive TUI launch. | high |
| Does `Stop` carry `last_assistant_message`? | **Not observed** (no successful turn). `StopFailure` does carry it — see §4. | blocked |
| Retry on non-2xx? | **No.** Exactly one delivery, error shown to the agent, action proceeds. | high |
| Does the design's hook config work as written? | **No.** `SessionStart` is never delivered to an `http` hook. See §7. | high, reproduced 3× |

## 1. The chat bridge — what ran, what did not

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

### What the human must do to close it

```bash
wsl -d Ubuntu
claude                    # then /login, complete the browser flow
claude -p "say ready"     # must print ready, not a 401
```

Then re-run §11's reproduction. The outstanding items are §4 (`Stop`), §5's "Not observed" table, and
the `PreToolUse` half of §2. Everything else in this document is already settled.

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

### Common envelope

Every payload carried `session_id`, `transcript_path`, `cwd`, `hook_event_name`, and — except on
`SessionStart` — `prompt_id`. Most carried `scratchpad_dir`; some carried `permission_mode` and
`effort.level`. `agent_id` / `agent_type` were absent (no subagents ran).

### Transport facts for ticket 005

- `http` hooks POST with `content-type: application/json`, `user-agent: axios/1.15.2`,
  `accept-encoding: gzip, compress, deflate, br`, `connection: keep-alive`.
- **No authentication, no signature, no shared secret on the request.** Anything that can reach the
  port can forge any event for any `session_id`. The ingest endpoint must bind loopback only, or
  carry a per-user token in the URL — which the hook config can hold, since query strings survive.
- Query strings on the hook URL do survive: `?src=project` came through intact, a cheap way to tag
  which config fragment produced an event.

### Not observed

| Event | Why | What would capture it |
| --- | --- | --- |
| **`Stop`** | Needs one successful assistant turn. Every turn died at the 401. | Log in; send one trivial prompt. |
| **`PreToolUse`** | Needs the model to call a tool. TUI bash mode (`!cmd`) runs the command but fires **no** `PreToolUse` — see §8.4. | Log in; ask the agent to read a file. |
| **`PostToolUse`** | Same. | Same. |
| **`PermissionRequest`** | Needs a tool call that is not pre-approved. The session sat in `manual` mode, ready to produce one. | Log in; ask for a write outside the allowlist. |
| **`PreCompact`** | `/compact` refused with `Not enough messages to compact` — needs a real conversation. | Log in; hold a conversation; `/compact`. |
| **`TaskCreated` / `TaskCompleted`** | Registered in the spike settings; never fired (no Claude-side task activity without the model). | Log in; let the agent use its own todo list. |

**Nothing in this section has an invented schema.** Tickets 005, 009, 010 and 020 must treat these six
events as unknown shapes until they are captured.

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

## 10. Needs a human

1. **Re-login in WSL.** `wsl -d Ubuntu` → `claude` → `/login`. Until then `Stop`, `PreToolUse`,
   `PostToolUse`, `PermissionRequest` and `PreCompact` cannot be captured, the `PreToolUse` blocking
   shape cannot be confirmed, and the chat bridge cannot be proven end to end. **Six tickets are
   waiting on results that are one login away.**
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
# listener
node spikes/hooks/echo-server.mjs            # PORT=8787, LOG=~/spike002-tmp/hook-events.jsonl
                                             # DELAY_MS=30000 to exercise the hook timeout

# a session wired to it
tmux new-session -d -s probe -c <workdir> \
  "claude --settings <repo>/spikes/hooks/settings.spike.json --session-id $(uuidgen)"
tmux send-keys -t probe "reply with the word ready"; tmux send-keys -t probe Enter

# make the listener block the next hook
curl -X POST localhost:8787/control/mode -H 'content-type: application/json' \
  -d '{"path":"/events/tool","status":200,"body":{"decision":"block","reason":"owned by another task"}}'

# and reset it
curl -X POST localhost:8787/control/mode -H 'content-type: application/json' \
  -d '{"path":"/events/tool","reset":true}'
```

`spikes/hooks/settings.spike.json` registers every event the design names, plus `UserPromptSubmit`
(spike instrumentation) and both model-switch events. `MessageDisplay` is deliberately absent, since
the design defers it past v1. `SessionStart` is registered there as `http` **exactly as the design
specifies it** — which is why §7 was visible at all.

Scratch material (echo-server log, throwaway projects, command-hook probes) lived in `~/spike002-tmp`
in WSL and was removed afterwards. Nothing outside this repo's three spike files was left behind.
