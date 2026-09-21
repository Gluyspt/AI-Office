# Spike 001 — Claude Code hook payloads and blocking semantics

**Ticket:** [002](../tasks/002-spike-hook-payloads.md) · **Department:** research · **Observed:** 2026-09-21/22

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
| Does the design's hook config work as written? | **No.** `SessionStart` is never delivered to an `http` hook. See §7. | high, reproduced 3× |

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

**Nothing in this section has an invented schema.** Tickets 005, 009, 010 and 020 must treat these
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
