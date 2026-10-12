// tmux argument construction — and, deliberately, no shell quoting at all.
//
// ## Read this before "fixing" the name
//
// Ticket 007 names this file `shell-quote.ts` and describes it as "argument
// construction and the message-delivery encoding chosen in ticket 003".
// Spike 003 then ran, and the encoding it chose has **no escaping step**:
//
//     tmux send-keys -t "$SESSION" -l -- "$TEXT"      # the whole message, one argument
//     tmux send-keys -t "$SESSION" Enter              # submit, as a SEPARATE call
//
// `docs/spikes/002-tmux-tui-control.md` §4 measured that across nine
// payload classes (double quote, single quote, backtick, `$HOME` and
// `$(id -u)`, `first; rm -rf ~; second`, `a|b&c>d<e*f?g[h]i{j}k`, CJK and
// emoji, an embedded newline, and all of them at once) — 35 of 36 trials
// arrived byte for byte at the agent, verified in Claude Code's own JSONL
// transcript rather than by scraping the pane. The single failure was a
// mechanism we do not use (see "Forbidden mechanisms" below).
//
// There is no shell anywhere in that path. Node's `spawn` with
// `shell: false` hands an argv array to `execve`; `sudo` passes its
// remaining argv through; tmux takes the text as one argv element and
// injects it into the pane as literal bytes. Nothing re-parses it. An
// escaper here would therefore have nothing to escape, and writing one
// would be actively harmful: it would mutate the payload (so the measured
// byte-for-byte result stops holding), and it would advertise a shell
// boundary that does not exist, inviting a later caller to build a command
// *string* and trust this module to make it safe.
//
// So this module is the boundary itself rather than an escaper. Its job:
//
//   - own every tmux argv array in the system, so "commands are argument
//     arrays, never string interpolation into a shell line" is a property
//     of one file and one table-driven test;
//   - **reject** what cannot be delivered intact, rather than silently
//     mangling or truncating it (`checkMessageText`);
//   - keep key names and message text in different, non-interchangeable
//     code paths, so text can never be interpreted as a keystroke.
//
// ## Forbidden mechanisms, and why
//
//   - **Bare `send-keys` without `-l`.** tmux parses each argument as a key
//     name first. Spike 002 probed this directly against a `cat` pane:
//     `send-keys -t <s> 'Enter'` delivered a newline — tmux pressed the
//     Enter *key* and the word never arrived — while `send-keys -t <s> -l
//     -- 'Enter'` delivered the five characters. A chat message that reads
//     `Enter`, `Escape`, `C-c`, `Space` or `Up` would be executed as a
//     keystroke. `-l` is mandatory for text, which is why `sendKeysArgs`
//     accepts only the closed `TmuxKey` set and `sendLiteralArgs` is the
//     only path text may take.
//   - **`--` is mandatory too.** Without it a payload beginning with `-`
//     is read as a flag. Verified on tmux 3.4 in this ticket: a message
//     starting `-n ;touch …` round-tripped as literal text through
//     `-l --`.
//   - **Plain `load-buffer` + `paste-buffer`.** Spike 002 §4: with an
//     embedded newline it *submitted early* — `line one` was sent as a
//     turn and `line two` was left in the composer. Half a message,
//     delivered and answered, no error raised anywhere. `paste-buffer -p`
//     (bracketed) was intact on all nine payloads and is the documented
//     fallback if a payload ever exceeds what one argv element can carry;
//     the un-bracketed form must not be used at all.
//
// ## Targeting
//
// Measured on tmux 3.4 in this ticket (see naming.ts's header for the
// transcript): tmux falls back to *prefix* matching for an unknown target,
// so a message addressed to a dead desk can land in a different live
// agent's pane. Both target builders below force exact matching, and they
// are the only supported way to name a session in an argv array. Note the
// two forms differ — `=name` is rejected by pane-addressed commands
// (`can't find pane: =name`), while `=name:` works for both — which is
// exactly the kind of detail that gets it wrong at a call site.

import { isValidSessionName } from "./naming.ts";

// --- Message text ------------------------------------------------------------

/**
 * Linux `MAX_ARG_STRLEN`: 32 pages, the kernel's hard ceiling on a single
 * `execve` argument. Past this the `sudo` exec fails with E2BIG and the
 * message never reaches tmux at all.
 *
 * **This never binds for `send-keys`.** tmux's own command-length limit is
 * eight times lower, measured below. The constant stays because it is the
 * ceiling for any *other* argument the adapter might build, and because its
 * failure mode differs: E2BIG comes from the kernel before tmux runs, and
 * reads "Argument list too long" rather than tmux's "command too long".
 * Both were observed on the VPS — tmux's at 64 KB, the kernel's at 256 KB
 * and above.
 */
export const EXECVE_ARG_BYTE_LIMIT = 131_072;

/**
 * **MEASURED on the target VPS, 2026-10-07. tmux 3.6, Ubuntu 26.04.**
 *
 * tmux rejects a `send-keys` whose WHOLE COMMAND exceeds this, with
 * `command too long` on stderr and a non-zero exit. It is a limit on the
 * command, not on the payload — which is the part that matters here, because
 * **the session name is part of the command and therefore eats into the
 * message.**
 *
 * Proven by binary search against a live pane, using this module's own
 * `paneTarget` form, at four session-name lengths:
 *
 * | name bytes | max payload | payload + overhead |
 * | --- | --- | --- |
 * |  2 | 16 339 | 16 365 |
 * | 21 | 16 320 | 16 365 |
 * | 51 | 16 290 | 16 365 |
 * | 99 | 16 242 | 16 365 |
 *
 * The total is constant and the payload shrinks byte for byte with the name.
 * Cross-checked independently against the spike harness driving a real
 * Claude Code pane through `sudo -n -u`, which bracketed a 21-byte name
 * between an accepted 16 302 bytes and a refused 16 342 — consistent with
 * the 16 320 above. Rows: `docs/spikes/002-vps-results/sizes.tsv`.
 *
 * Why this is not a cosmetic number: session names come from `naming.ts` and
 * encode project, role, department and owner, so **a long project name
 * silently lowers the longest message an agent can be sent.** A flat limit
 * cannot express that, and the previous default — `EXECVE_ARG_BYTE_LIMIT`,
 * 131 072 — was eight times too high, so a 100 KB brief passed the adapter's
 * own gate and was then refused by tmux. Loudly, so nothing was corrupted,
 * but the error named the wrong layer.
 */
export const TMUX_COMMAND_BYTE_LIMIT = 16_365;

/**
 * Bytes of `send-keys -t =<name>: -l -- <payload>` that are not the payload,
 * for a given session name: the subcommand, the flags, the `=`/`:` of
 * `paneTarget`, and the spaces tmux joins its argv with.
 */
const SEND_KEYS_OVERHEAD_BYTES = 24;

/**
 * Margin held back from the measured limit. The measurement is one tmux
 * version on one host; a build with slightly different internal framing
 * would move the boundary by a few bytes, and the failure that margin
 * prevents is a refusal at send time for a message the adapter promised to
 * accept. 64 bytes costs 0.4% of capacity.
 */
const TMUX_LIMIT_SAFETY_MARGIN_BYTES = 64;

/**
 * The longest message, in BYTES, that `sendLiteral`/`sendMessage` can deliver
 * to this session name. Bytes, not characters: the limit is on the command
 * tmux builds, and one emoji is four bytes of it.
 *
 * Callers should prefer this over a flat configured maximum — or take the
 * lower of the two, which is what the adapter does.
 */
export function maxMessageBytesFor(sessionName: string): number {
  const nameBytes = Buffer.byteLength(sessionName, "utf8");
  return (
    TMUX_COMMAND_BYTE_LIMIT -
    nameBytes -
    SEND_KEYS_OVERHEAD_BYTES -
    TMUX_LIMIT_SAFETY_MARGIN_BYTES
  );
}

export type MessageRejectionKind = "empty" | "nul_byte" | "carriage_return" | "too_long";

export interface MessageRejection {
  readonly kind: MessageRejectionKind;
  readonly message: string;
}

export type MessageCheck =
  | { readonly ok: true; readonly byteLength: number }
  | { readonly ok: false; readonly rejection: MessageRejection };

/**
 * The only gate message text passes through. Everything it rejects is
 * something that would otherwise be delivered *wrong* without an error —
 * the failure mode spike 002 caught with `paste-buffer` and the reason this
 * module exists.
 *
 * Deliberately NOT rejected: quotes, backticks, `$`, `;`, pipes, braces,
 * CJK, emoji and `\n`. All nine measured intact through `-l --`; stripping
 * or escaping any of them would corrupt a legitimate message.
 */
export function checkMessageText(text: string, maxBytes: number = TMUX_COMMAND_BYTE_LIMIT): MessageCheck {
  if (text.length === 0) {
    return { ok: false, rejection: { kind: "empty", message: "message text is empty" } };
  }
  if (text.includes("\0")) {
    // execve arguments are NUL-terminated: the kernel would silently
    // deliver the prefix and drop the rest. Truncation with no error is
    // precisely what the acceptance criterion forbids.
    return {
      ok: false,
      rejection: {
        kind: "nul_byte",
        message: "message contains a NUL byte, which execve would silently truncate at",
      },
    };
  }
  if (text.includes("\r")) {
    // Untested and dangerous. `\n` was measured intact and stays a soft
    // newline in the composer; CR is the byte tmux sends for the Enter
    // *key*, so a literal CR would most likely submit the message early
    // and split it in two — the `paste-buffer` failure, arriving by a
    // different route. It is rejected rather than normalised because
    // rewriting a message without telling anyone is the other half of that
    // same bug. A caller that knows its source emits CRLF should normalise
    // before calling, as a visible decision.
    return {
      ok: false,
      rejection: {
        kind: "carriage_return",
        message:
          "message contains a carriage return; CR is the Enter keystroke and would submit the message early. Normalise CRLF to LF at the caller",
      },
    };
  }
  const byteLength = Buffer.byteLength(text, "utf8");
  if (byteLength > maxBytes) {
    return {
      ok: false,
      rejection: {
        kind: "too_long",
        message: `message is ${byteLength} bytes, over the ${maxBytes}-byte limit; delivery would be truncated or fail at exec`,
      },
    };
  }
  return { ok: true, byteLength };
}

// --- Keys --------------------------------------------------------------------

/**
 * The closed set of keystrokes the orchestrator is allowed to press. It is
 * closed on purpose: an open `string` parameter here would reintroduce
 * exactly the bug `-l` exists to prevent, by letting a caller pass text
 * that happens to be a key name down the key path.
 *
 * `Enter` submits (always a separate call from the text — spike 002 §4).
 * `Escape` interrupts a turn (§3: 3/3, ~124 ms, session alive).
 * `C-u` clears one line of the composer — needed before the next message
 * after an interrupt, because the TUI restores the interrupted prompt into
 * the input box (spike 001) and the next `send-keys` would concatenate.
 */
export const TMUX_KEYS = ["Enter", "Escape", "C-u"] as const;
export type TmuxKey = (typeof TMUX_KEYS)[number];

export function isTmuxKey(value: string): value is TmuxKey {
  return (TMUX_KEYS as readonly string[]).includes(value);
}

// --- Targets -----------------------------------------------------------------

function requireValidName(name: string): string {
  if (!isValidSessionName(name)) {
    throw new TypeError(`illegal tmux session name: ${JSON.stringify(name)}`);
  }
  return name;
}

/** Exact-match target for session-addressed commands (`has-session`, `kill-session`). */
export function sessionTarget(name: string): string {
  return `=${requireValidName(name)}`;
}

/**
 * Exact-match target for pane-addressed commands (`send-keys`,
 * `capture-pane`). The trailing colon is load-bearing: tmux 3.4 rejects
 * `=name` for a pane target with `can't find pane: =name`, while `=name:`
 * resolves to that session's current pane and still refuses a prefix match.
 */
export function paneTarget(name: string): string {
  return `=${requireValidName(name)}:`;
}

// --- Argument arrays ---------------------------------------------------------
//
// Every tmux invocation in the system is assembled here. None of these
// functions concatenates, interpolates or quotes — each returns an array
// whose elements become argv elements one-for-one.

/** Spike 002's chosen delivery mechanism, verbatim. Does not submit. */
export function sendLiteralArgs(name: string, text: string): string[] {
  return ["send-keys", "-t", paneTarget(name), "-l", "--", text];
}

/** Key presses only — never text. See `TMUX_KEYS`. */
export function sendKeysArgs(name: string, keys: readonly TmuxKey[]): string[] {
  if (keys.length === 0) {
    throw new TypeError("sendKeysArgs requires at least one key");
  }
  for (const key of keys) {
    if (!isTmuxKey(key)) {
      throw new TypeError(`not an allowed tmux key: ${JSON.stringify(key)}`);
    }
  }
  return ["send-keys", "-t", paneTarget(name), ...keys];
}

export function hasSessionArgs(name: string): string[] {
  return ["has-session", "-t", sessionTarget(name)];
}

export function killSessionArgs(name: string): string[] {
  return ["kill-session", "-t", sessionTarget(name)];
}

/** One name per line. No `kill-server`, ever — other people have sessions on this box. */
export function listSessionsArgs(): string[] {
  return ["list-sessions", "-F", "#{session_name}"];
}

export function capturePaneArgs(name: string, historyLines = 0): string[] {
  const args = ["capture-pane", "-p", "-t", paneTarget(name)];
  if (historyLines > 0) {
    args.push("-S", `-${historyLines}`);
  }
  return args;
}

export type CommandRejectionKind = "empty_command" | "shell_metacharacters" | "invalid_env";

export interface CommandRejection {
  readonly kind: CommandRejectionKind;
  readonly message: string;
}

export interface NewSessionArgsInput {
  readonly name: string;
  readonly cwd: string;
  readonly command: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cols: number;
  readonly rows: number;
}

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Safe to hand to `sh -c` unquoted, i.e. it means the same thing either way. */
const SHELL_SAFE_WORD_RE = /^[A-Za-z0-9._/@+-]+$/;

/**
 * The one place tmux itself can introduce a shell, and the reason this
 * check exists.
 *
 * **Measured on tmux 3.4 (WSL, this ticket).** `new-session` runs its
 * trailing arguments through `execvp` when there is more than one, and
 * through `/bin/sh -c` when there is exactly one:
 *
 *   - `new-session -d -s s "touch /tmp/t007/SHELL_RAN; sleep 30"`
 *     → the marker file was created: a shell ran the string.
 *   - `new-session -d -s s -- /bin/bash -c '…' bash 'lit;eral > /tmp/t007/PWNED' 'back`tick`$HOME'`
 *     → the child's `"$@"` held both arguments byte for byte and no
 *       `PWNED` file was created: argv passed straight through, no shell.
 *
 * The design's own example is the single-argument form
 * (`'CLAUDE_CONFIG_DIR=… claude --agent dev-lead'`), which needs a shell to
 * apply the inline assignment. This adapter does not use it: environment
 * goes through `new-session -e` and the command is an argv array, so the
 * launch path has no shell either. A one-element command is still allowed
 * when the element is a bare word that means the same thing through `sh -c`
 * as through `execvp`; anything else is rejected rather than quoted,
 * because quoting for a shell we are trying not to use is how this stops
 * being verifiable.
 */
export function checkCommand(command: readonly string[]): CommandRejection | undefined {
  if (command.length === 0) {
    return { kind: "empty_command", message: "command must have at least one element" };
  }
  const first = command[0] ?? "";
  if (command.length === 1 && !SHELL_SAFE_WORD_RE.test(first)) {
    return {
      kind: "shell_metacharacters",
      message: `a one-element command is passed to sh -c by tmux; ${JSON.stringify(first)} is not a bare word. Split it into argv elements`,
    };
  }
  return undefined;
}

export function checkEnv(env: Readonly<Record<string, string>>): CommandRejection | undefined {
  for (const [key, value] of Object.entries(env)) {
    if (!ENV_KEY_RE.test(key)) {
      return { kind: "invalid_env", message: `illegal environment variable name: ${JSON.stringify(key)}` };
    }
    if (value.includes("\0") || value.includes("\n")) {
      return {
        kind: "invalid_env",
        message: `value of ${key} contains a NUL or newline, which cannot survive an execve argument`,
      };
    }
  }
  return undefined;
}

/**
 * `-e KEY=VALUE` is one argv element, so a value containing spaces or
 * quotes needs no handling — and `-e` is why no shell is needed to set
 * `CLAUDE_CONFIG_DIR` (or `NODE_EXTRA_CA_CERTS`, which spike 001 §12 found
 * every hook silently needs). Requires tmux >= 3.2.
 *
 * Env keys are sorted so the argv array is deterministic and can be
 * asserted on.
 */
export function newSessionArgs(input: NewSessionArgsInput): string[] {
  const args = [
    "new-session",
    "-d",
    "-s",
    requireValidName(input.name),
    "-x",
    String(input.cols),
    "-y",
    String(input.rows),
    "-c",
    input.cwd,
  ];
  for (const key of Object.keys(input.env).sort()) {
    args.push("-e", `${key}=${input.env[key] ?? ""}`);
  }
  args.push("--", ...input.command);
  return args;
}
