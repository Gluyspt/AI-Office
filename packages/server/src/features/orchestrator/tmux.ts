// The tmux adapter: start, address and stop agent desks.
//
// This is the only place in the system where text a human typed in a
// browser reaches a process running as a different Linux user. Everything
// above it — the session registry (008), chat (010/026), interrupt and
// pause (027/028) — is a caller of the functions below. Four properties
// are the point of the file, and each is enforced here rather than trusted
// to callers:
//
//  1. **Argument arrays, never a shell line.** Nothing in this file builds
//     a command string. `spawn` is called with `shell: false` and an argv
//     array assembled by shell-quote.ts. Read that file's header for why
//     there is no escaping step and why adding one would be a regression.
//     tmux's own `new-session` can introduce a shell — it runs a
//     *single* trailing argument through `sh -c` — and `checkCommand`
//     closes that door too.
//
//  2. **Never root, and never a caller-chosen `sudo -u` target.** Every
//     invocation goes through `sudo -n -u <user> <tmuxPath>`, with `<user>`
//     checked against an allowlist that comes from configuration
//     (`TMUX_AGENT_USERS`, mirroring `deploy/sudoers.d/office`) — i.e. from
//     the registry side of the system, never from a request. The adapter
//     also refuses to run at all as uid 0.
//
//  3. **Every invocation has a timeout.** `sudo -n` cannot prompt, but it
//     can still hang; a wedged call is SIGKILLed and returns a typed
//     `timeout` rather than parking a promise or leaking a process.
//
//  4. **Typed results, not exceptions, for operational outcomes.** A
//     missing session, an unknown user, a message that cannot be delivered
//     — each is a value the caller has to handle. Only programmer errors
//     (an illegal session name reaching a target builder) throw.
//
// ## What is measured and what is not
//
// `docs/spikes/002-tmux-tui-control.md` is the source for the delivery
// mechanism (§4), the Escape interrupt (§3), the mid-turn queue (§2) and
// SessionEnd on kill (§5). **Every one of those rows was taken on WSL2
// with `SPIKE_USER` empty, i.e. with no `sudo` in the tmux path at all**,
// and §7 (`sudo -u` parity) is DEFERRED, NOT ATTEMPTED — `$HOME`,
// `CLAUDE_CONFIG_DIR` resolution and whether two users share a tmux socket
// are all unknown for the shape this adapter actually uses. The adapter is
// written to the `sudo -n -u` form because that is what the VPS will run;
// it is not claimed to behave identically to the unwrapped calls that were
// measured. Ticket 007's VPS re-measurement criterion is what closes this.
//
// ## Two hazards this file defends against but does not solve
//
//  - **A chat message delivered while a permission dialog is up approves
//    the pending tool call.** Spike 002 §1, 3/3, verified in the transcript
//    and by the file the approved command created. `sendMessage` refuses to
//    deliver when it can see a permission dialog in the pane — but that is
//    best-effort pane scraping, and pane strings moved twice during the
//    spike. **Ticket 008 must gate delivery on dialog state properly; this
//    check is not that gate.**
//  - **`esc to interrupt` is not a busy signal.** It clears 148–342 ms
//    after a message is *submitted* while the turn runs on (spike §2). This
//    adapter therefore exposes no `isBusy()`. Anything that needs busy/idle
//    must get it from hook events (010), not from this pane.

import { spawn } from "node:child_process";
import { loadTmuxConfig } from "../../core/config.ts";
import { isOfficeSessionName, isValidSessionName } from "./naming.ts";
import {
  capturePaneArgs,
  checkCommand,
  checkEnv,
  checkMessageText,
  hasSessionArgs,
  killSessionArgs,
  listSessionsArgs,
  newSessionArgs,
  sendKeysArgs,
  sendLiteralArgs,
  type TmuxKey,
} from "./shell-quote.ts";

// --- Result types -------------------------------------------------------------

export type TmuxErrorKind =
  /** The orchestrator process is uid 0. It must never be. */
  | "refused_root"
  /** The `sudo -u` target is not in the configured allowlist. */
  | "unknown_user"
  | "invalid_session_name"
  /** Message text that cannot be delivered intact — see `checkMessageText`. */
  | "invalid_message"
  | "invalid_command"
  /** The invocation exceeded its timeout and was killed. */
  | "timeout"
  /** `sudo`/`tmux` could not be executed at all (ENOENT, EACCES). */
  | "spawn_failed"
  /** sudo refused: no rule, a password required, no tty. */
  | "sudo_denied"
  /** tmux has no such session. */
  | "not_found"
  /** No tmux server is running for that user. */
  | "no_server"
  | "duplicate_session"
  /** The composer never came up within the readiness deadline. */
  | "not_ready"
  /** The pane shows a login/credit failure; nothing sent would be answered. */
  | "auth_failed"
  /** A dialog is up. Delivering into it would answer it. */
  | "blocked_by_dialog"
  /** tmux exited non-zero for a reason not classified above. */
  | "tmux_error";

export interface TmuxFailure {
  readonly ok: false;
  readonly kind: TmuxErrorKind;
  readonly message: string;
  readonly exitCode?: number | null;
  readonly stderr?: string;
  /** Last pane capture, when the failure was decided by reading the pane. */
  readonly pane?: string;
}

export type TmuxResult<T> = { readonly ok: true; readonly value: T } | TmuxFailure;

function fail(kind: TmuxErrorKind, message: string, extra: Partial<TmuxFailure> = {}): TmuxFailure {
  return { ok: false, kind, message, ...extra };
}

// --- The process seam ---------------------------------------------------------

export interface CommandRequest {
  readonly file: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
}

export interface CommandOutcome {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly spawnError?: Error;
}

/**
 * Everything that actually executes goes through one function, so tests
 * can assert on exact argv arrays without a tmux (or a sudo, or a Linux)
 * anywhere, and the real implementation's timeout behaviour can be tested
 * on its own against a stub binary that sleeps.
 */
export type CommandRunner = (request: CommandRequest) => Promise<CommandOutcome>;

export const spawnRunner: CommandRunner = (request) =>
  new Promise<CommandOutcome>((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    // `shell: false` is the guarantee the whole ticket rests on: argv
    // elements go to execve one-for-one and nothing re-parses them. It is
    // spelled out rather than left to the default so that deleting it is a
    // visible change.
    let child;
    try {
      child = spawn(request.file, [...request.args], {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ code: null, signal: null, stdout: "", stderr: "", timedOut: false, spawnError: error as Error });
      return;
    }

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    // SIGKILL, not SIGTERM: the thing being defended against is a process
    // that is not responding. Note that killing `sudo` does not by itself
    // reap a grandchild — which is survivable here only because every
    // command this adapter runs is a short-lived tmux *client*
    // (`new-session -d` returns as soon as the server has forked), never a
    // long-running process. Anything that changes is a new hazard.
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, request.timeoutMs);
    timer.unref?.();

    const finish = (outcome: CommandOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };

    child.on("error", (error: Error) => {
      finish({ code: null, signal: null, stdout, stderr, timedOut, spawnError: error });
    });
    child.on("close", (code, signal) => {
      finish({ code, signal, stdout, stderr, timedOut });
    });
  });

/**
 * `sudo -n -u <user> <tmux> <args…>` — the exact shape spike 002's harness
 * uses and the shape the VPS will run. `-n` is not optional: a rule that
 * still demands a password must fail immediately and visibly rather than
 * block on a prompt that no one will ever see.
 */
export function buildTmuxCommand(input: {
  readonly sudoPath: string;
  readonly tmuxPath: string;
  readonly user: string;
  readonly args: readonly string[];
}): { readonly file: string; readonly args: readonly string[] } {
  return {
    file: input.sudoPath,
    args: ["-n", "-u", input.user, input.tmuxPath, ...input.args],
  };
}

// --- Pane reading -------------------------------------------------------------

/** The input box's horizontal rules. */
const RULE = "─";
/** The composer's prompt marker. */
const PROMPT_MARKER = "❯";
/** The TUI pads the composer with U+00A0, which `[ \t]` never trims. */
const NBSP = " ";

const RE_AUTH_FAIL = /Please run \/login|OAuth access token is invalid|Invalid API key|Credit balance is too low/;
const RE_TRUST = /Is this a project you created or one you trust|trust this folder/i;
const RE_PERMISSION = /Do you want to |Yes, and don.t ask again|Allow this tool|^\s*1\. Yes/m;
const RE_MODAL = /Enter to confirm|Esc to cancel/;

export type PaneState =
  | "composer_ready"
  | "trust_dialog"
  | "permission_dialog"
  | "modal"
  | "auth_failed"
  | "unknown";

/**
 * What the pane is showing, in the order it has to be asked.
 *
 * Dialogs are tested **before** readiness, because the composer's own
 * structure can still be on screen underneath a modal — check readiness
 * first and the opening brief gets typed into the dialog, which is the
 * exact failure spike 002 documents.
 *
 * Readiness itself keys on the composer's *structure* (two U+2500 rules
 * with a U+276F prompt marker between them), never on a hint string.
 * Spike 002 found the hint line moves with the permission mode on a single
 * build — `? for shortcuts` becomes `⏵⏵ auto mode on (shift+tab to cycle)`
 * — and the harness declared a live, input-accepting session `not_ready`
 * for 90 s because of it. An unrecognised pane is `unknown`, i.e. NOT
 * ready; there is no optimistic branch.
 *
 * This is still pane scraping, and pane scraping is version-fragile: the
 * TUI changed twice under the spike, once from an auto-update mid-run.
 * Whether to pin the Claude Code CLI on the VPS is an open question on
 * this ticket and on 009, and it is this function that pays for a wrong
 * answer.
 */
export function classifyPane(pane: string): PaneState {
  if (RE_AUTH_FAIL.test(pane)) return "auth_failed";
  // Trust before permission: the folder-trust dialog is the one dialog we
  // are allowed to answer, and its wording is specific enough that a
  // permission dialog can never match it.
  if (RE_TRUST.test(pane)) return "trust_dialog";
  if (RE_PERMISSION.test(pane)) return "permission_dialog";
  if (RE_MODAL.test(pane)) return "modal";
  if (composerText(pane) !== undefined) return "composer_ready";
  return "unknown";
}

/**
 * The text sitting in the input box, or `undefined` when no composer is on
 * screen. Reading the whole pane instead is how a check ends up passing on
 * text that was submitted a minute ago and is still scrolled on screen.
 */
export function composerText(pane: string): string | undefined {
  const lines = pane.split(/\r?\n/);
  const rules: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.includes(RULE.repeat(3))) rules.push(index);
  }
  if (rules.length < 2) return undefined;
  const bottom = rules[rules.length - 1] ?? -1;
  const top = rules[rules.length - 2] ?? -1;
  if (top < 0 || bottom <= top) return undefined;

  const body: string[] = [];
  let sawMarker = false;
  for (let index = top + 1; index < bottom; index += 1) {
    const raw = lines[index] ?? "";
    if (raw.includes(PROMPT_MARKER)) sawMarker = true;
    body.push(raw.split(PROMPT_MARKER).join("").split(NBSP).join(" ").trim());
  }
  if (!sawMarker) return undefined;
  return body.join("\n").trim();
}

// --- Adapter ------------------------------------------------------------------

export interface NewSessionRequest {
  /** Must be in the configured allowlist. Never taken from a request body. */
  readonly user: string;
  /** Produced by naming.ts's `sessionName`. */
  readonly name: string;
  /** The project working directory the agent is spawned inside. */
  readonly cwd: string;
  /**
   * argv, not a command line. Two or more elements are `execvp`'d by tmux;
   * one element is handed to `sh -c`, so a single element must be a bare
   * word (`checkCommand` enforces this).
   */
  readonly command: readonly string[];
  /**
   * Which login the agent uses. Set via `new-session -e`, not via the
   * design's inline `'CLAUDE_CONFIG_DIR=… claude'` form, because the inline
   * form needs a shell. Whether `-e` survives `sudo -u` is unmeasured —
   * spike 002 §7 is DEFERRED — and is part of the VPS re-measurement.
   */
  readonly configDir?: string;
  /**
   * Extra environment for the pane process. `NODE_EXTRA_CA_CERTS` belongs
   * here: spike 001 §12 found that without it every https hook silently
   * fails its TLS handshake and no event is ever delivered. Ticket 009
   * owns deciding what goes in; this adapter owns the mechanism.
   */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Default true. When false the call returns as soon as tmux reports the
   * session, without confirming the composer is up — for a caller that
   * will drive readiness itself. Nothing should send a brief after a
   * `false` here.
   */
  readonly waitForComposer?: boolean;
}

export interface NewSessionOutcome {
  readonly name: string;
  /** Which first-run dialogs stood between launch and a usable prompt. */
  readonly dialogsAnswered: readonly string[];
  /** ms from session start to a composer, or null if readiness was skipped. */
  readonly readyMs: number | null;
}

export interface ListSessionsOutcome {
  /** Sessions this orchestrator could have created (`office-…`). */
  readonly names: readonly string[];
  /** Everything else that user has open. Reported, never acted on. */
  readonly foreign: readonly string[];
}

export interface TmuxAdapter {
  newSession(request: NewSessionRequest): Promise<TmuxResult<NewSessionOutcome>>;
  hasSession(user: string, name: string): Promise<TmuxResult<{ readonly exists: boolean }>>;
  listSessions(user: string): Promise<TmuxResult<ListSessionsOutcome>>;
  capturePane(user: string, name: string): Promise<TmuxResult<{ readonly pane: string }>>;
  sendLiteral(user: string, name: string, text: string): Promise<TmuxResult<{ readonly byteLength: number }>>;
  sendKeys(user: string, name: string, keys: readonly TmuxKey[]): Promise<TmuxResult<Record<string, never>>>;
  sendEscape(user: string, name: string): Promise<TmuxResult<Record<string, never>>>;
  clearComposer(user: string, name: string): Promise<TmuxResult<{ readonly clears: number }>>;
  sendMessage(user: string, name: string, text: string): Promise<TmuxResult<{ readonly byteLength: number }>>;
  killSession(user: string, name: string): Promise<TmuxResult<Record<string, never>>>;
}

export interface TmuxAdapterOptions {
  /** Mirrors `deploy/sudoers.d/office`. The only legal `sudo -u` targets. */
  readonly agentUsers: readonly string[];
  readonly sudoPath?: string;
  readonly tmuxPath?: string;
  readonly commandTimeoutMs?: number;
  readonly readyTimeoutMs?: number;
  readonly maxMessageBytes?: number;
  readonly sessionCols?: number;
  readonly sessionRows?: number;
  /** How long `hasSession` is given to see a just-started session. */
  readonly sessionVisibleTimeoutMs?: number;
  readonly readyPollIntervalMs?: number;
  /** Spike 002's `sleep 0.3` between the literal text and the submit. */
  readonly composerSettleMs?: number;
  readonly run?: CommandRunner;
  readonly getuid?: () => number | undefined;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

const DEFAULT_SESSION_VISIBLE_TIMEOUT_MS = 2_000;
const DEFAULT_READY_POLL_INTERVAL_MS = 500;
const DEFAULT_COMPOSER_SETTLE_MS = 300;
const DEFAULT_DIALOG_SETTLE_MS = 1_500;
const MAX_DIALOGS_ANSWERED = 10;
/** `C-u` clears one composer line, so a multi-line draft needs several. */
const MAX_COMPOSER_CLEARS = 12;

function classifyStderr(stderr: string): TmuxErrorKind | undefined {
  // sudo's own refusals come first: they are our misconfiguration, and
  // reporting one as "session not found" would send an operator hunting in
  // exactly the wrong place.
  if (/password is required|not allowed to execute|is not in the sudoers file|no tty present|sudo: unable|a terminal is required/i.test(stderr)) {
    return "sudo_denied";
  }
  if (/duplicate session/i.test(stderr)) return "duplicate_session";
  if (/can't find (session|pane|window)|session not found/i.test(stderr)) return "not_found";
  if (/no server running|error connecting to|failed to connect to server/i.test(stderr)) return "no_server";
  return undefined;
}

export function createTmuxAdapter(options: TmuxAdapterOptions): TmuxAdapter {
  const run = options.run ?? spawnRunner;
  const sudoPath = options.sudoPath ?? "/usr/bin/sudo";
  const tmuxPath = options.tmuxPath ?? "/usr/bin/tmux";
  const commandTimeoutMs = options.commandTimeoutMs ?? 10_000;
  const readyTimeoutMs = options.readyTimeoutMs ?? 120_000;
  const maxMessageBytes = options.maxMessageBytes ?? 131_072;
  const sessionCols = options.sessionCols ?? 200;
  const sessionRows = options.sessionRows ?? 50;
  const sessionVisibleTimeoutMs = options.sessionVisibleTimeoutMs ?? DEFAULT_SESSION_VISIBLE_TIMEOUT_MS;
  const readyPollIntervalMs = options.readyPollIntervalMs ?? DEFAULT_READY_POLL_INTERVAL_MS;
  const composerSettleMs = options.composerSettleMs ?? DEFAULT_COMPOSER_SETTLE_MS;
  const getuid = options.getuid ?? (() => process.getuid?.());
  const now = options.now ?? (() => Date.now());
  const sleep =
    options.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
      }));

  const allowed = new Set(options.agentUsers);

  function guard(user: string, name?: string): TmuxFailure | undefined {
    const uid = getuid();
    if (uid === 0) {
      return fail(
        "refused_root",
        "the tmux adapter refuses to run as root; the orchestrator runs as the unprivileged office user and reaches agent accounts only through the scoped sudoers rule",
      );
    }
    if (!allowed.has(user)) {
      // The message deliberately does not echo the rejected value into a
      // log line an attacker controls beyond a JSON-quoted form.
      return fail(
        "unknown_user",
        `${JSON.stringify(user)} is not a configured agent account; sudo -u targets come from TMUX_AGENT_USERS (mirroring deploy/sudoers.d/office), never from a request`,
      );
    }
    if (name !== undefined && !isValidSessionName(name)) {
      return fail("invalid_session_name", `illegal tmux session name: ${JSON.stringify(name)}`);
    }
    return undefined;
  }

  async function tmux(
    user: string,
    args: readonly string[],
  ): Promise<TmuxResult<{ readonly stdout: string; readonly stderr: string }>> {
    const command = buildTmuxCommand({ sudoPath, tmuxPath, user, args });
    const outcome = await run({ file: command.file, args: command.args, timeoutMs: commandTimeoutMs });

    if (outcome.timedOut) {
      return fail("timeout", `tmux ${args[0] ?? ""} exceeded ${commandTimeoutMs}ms and was killed`, {
        stderr: outcome.stderr,
      });
    }
    if (outcome.spawnError) {
      return fail("spawn_failed", `could not execute ${command.file}: ${outcome.spawnError.message}`);
    }
    if (outcome.code !== 0) {
      const kind = classifyStderr(outcome.stderr) ?? "tmux_error";
      return fail(kind, `tmux ${args[0] ?? ""} exited ${String(outcome.code)}: ${outcome.stderr.trim()}`, {
        exitCode: outcome.code,
        stderr: outcome.stderr,
      });
    }
    return { ok: true, value: { stdout: outcome.stdout, stderr: outcome.stderr } };
  }

  async function capturePane(user: string, name: string): Promise<TmuxResult<{ readonly pane: string }>> {
    const refused = guard(user, name);
    if (refused) return refused;
    const result = await tmux(user, capturePaneArgs(name));
    if (!result.ok) return result;
    return { ok: true, value: { pane: result.value.stdout } };
  }

  async function hasSession(user: string, name: string): Promise<TmuxResult<{ readonly exists: boolean }>> {
    const refused = guard(user, name);
    if (refused) return refused;
    const result = await tmux(user, hasSessionArgs(name));
    if (result.ok) return { ok: true, value: { exists: true } };
    // "no such session" and "no server at all" are both honest answers to
    // "does this exist", not errors.
    if (result.kind === "not_found" || result.kind === "no_server") {
      return { ok: true, value: { exists: false } };
    }
    return result;
  }

  async function sendKeys(
    user: string,
    name: string,
    keys: readonly TmuxKey[],
  ): Promise<TmuxResult<Record<string, never>>> {
    const refused = guard(user, name);
    if (refused) return refused;
    const result = await tmux(user, sendKeysArgs(name, keys));
    return result.ok ? { ok: true, value: {} } : result;
  }

  async function sendLiteral(
    user: string,
    name: string,
    text: string,
  ): Promise<TmuxResult<{ readonly byteLength: number }>> {
    const refused = guard(user, name);
    if (refused) return refused;
    const check = checkMessageText(text, maxMessageBytes);
    if (!check.ok) {
      return fail("invalid_message", check.rejection.message);
    }
    const result = await tmux(user, sendLiteralArgs(name, text));
    return result.ok ? { ok: true, value: { byteLength: check.byteLength } } : result;
  }

  async function clearComposer(
    user: string,
    name: string,
  ): Promise<TmuxResult<{ readonly clears: number }>> {
    // How many `C-u` presses depends on how many lines are in the draft,
    // because Ctrl-U clears one line. The count is read from the pane; if
    // the pane cannot be read, fall back to a small fixed number rather
    // than failing — an over-clear is harmless, an under-clear concatenates
    // the next message onto a leftover draft.
    const captured = await capturePane(user, name);
    let clears = 3;
    if (captured.ok) {
      const draft = composerText(captured.value.pane);
      if (draft !== undefined) {
        clears = Math.min(draft.split("\n").length + 1, MAX_COMPOSER_CLEARS);
      }
    }
    for (let index = 0; index < clears; index += 1) {
      const result = await sendKeys(user, name, ["C-u"]);
      if (!result.ok) return result;
    }
    return { ok: true, value: { clears } };
  }

  async function sendMessage(
    user: string,
    name: string,
    text: string,
  ): Promise<TmuxResult<{ readonly byteLength: number }>> {
    const refused = guard(user, name);
    if (refused) return refused;
    const check = checkMessageText(text, maxMessageBytes);
    if (!check.ok) return fail("invalid_message", check.rejection.message);

    // Best-effort refusal to type into a dialog. Spike 002 §1: a chat
    // message delivered while a permission dialog is up selects the
    // highlighted `1. Yes` and the tool runs — 3/3, proven by the file the
    // approved command created. This check is defence in depth over
    // fragile pane strings, NOT the gate; ticket 008 owns that.
    const captured = await capturePane(user, name);
    if (!captured.ok) return captured;
    const state = classifyPane(captured.value.pane);
    if (state === "permission_dialog" || state === "trust_dialog" || state === "modal") {
      return fail(
        "blocked_by_dialog",
        `refusing to deliver: the pane is showing a ${state}. Sending now would answer it, not message the agent`,
        { pane: captured.value.pane },
      );
    }
    if (state === "auth_failed") {
      return fail("auth_failed", "the pane shows a login or credit failure; nothing sent would be answered", {
        pane: captured.value.pane,
      });
    }
    if (state !== "composer_ready") {
      return fail("not_ready", "no composer on screen; refusing to send into an unrecognised pane", {
        pane: captured.value.pane,
      });
    }

    // An interrupt restores the interrupted prompt into the input box
    // (spike 001), so without this the next message is concatenated onto
    // the last one.
    const cleared = await clearComposer(user, name);
    if (!cleared.ok) return cleared;

    const literal = await sendLiteral(user, name, text);
    if (!literal.ok) return literal;

    // The submit is a SEPARATE call, with the TUI given a moment to settle
    // — spike 002 §4's verbatim decision. Combining them into one
    // `send-keys` would put the message text back on the key-parsing path.
    await sleep(composerSettleMs);
    const submitted = await sendKeys(user, name, ["Enter"]);
    if (!submitted.ok) return submitted;
    return { ok: true, value: { byteLength: literal.value.byteLength } };
  }

  async function killSession(user: string, name: string): Promise<TmuxResult<Record<string, never>>> {
    const refused = guard(user, name);
    if (refused) return refused;
    const result = await tmux(user, killSessionArgs(name));
    // `not_found` is returned as a typed failure, never thrown: killing
    // something already gone is a routine race (the agent exited, or a
    // human killed the pane) and every caller has to handle it.
    return result.ok ? { ok: true, value: {} } : result;
  }

  async function waitForComposer(
    user: string,
    name: string,
  ): Promise<TmuxResult<{ readonly dialogsAnswered: string[]; readonly readyMs: number }>> {
    const started = now();
    const deadline = started + readyTimeoutMs;
    const dialogsAnswered: string[] = [];
    let lastPane = "";

    while (now() < deadline) {
      const captured = await capturePane(user, name);
      if (!captured.ok) return captured;
      lastPane = captured.value.pane;

      switch (classifyPane(lastPane)) {
        case "auth_failed":
          return fail("auth_failed", "the login was rejected; the session is up but can never answer", {
            pane: lastPane,
          });
        case "permission_dialog":
          // Never answered here. Enter selects the highlighted `1. Yes`.
          return fail(
            "blocked_by_dialog",
            "a permission dialog is up at startup; refusing to answer it with a keystroke",
            { pane: lastPane },
          );
        case "trust_dialog": {
          // Enter, because that is what was measured: spike 002's harness
          // answers the folder-trust dialog with Enter and reached a
          // composer every time on Claude Code 2.1.278.
          //
          // **Open question, left open.** Spike 001 §8.1 recorded `Down`
          // then `Enter` selecting "Yes, I trust this folder" on an earlier
          // build — so the highlighted default moved between versions, and
          // on that build a bare Enter would decline. No attempt is made
          // here to guess which build the VPS will run: a wrong guess
          // presses a *different option in a dialog*, which is exactly the
          // class of action this adapter otherwise refuses to take. If the
          // dialog is still up on the next poll the loop tries again and
          // eventually reports `not_ready` with the pane attached, rather
          // than walking the option list. The real fix is upstream:
          // provisioning (ticket 009) should pre-trust the working
          // directory so this dialog never appears — spike 001 §8.1 says
          // the same.
          const pressed = await sendKeys(user, name, ["Enter"]);
          if (!pressed.ok) return pressed;
          dialogsAnswered.push("trust(Enter)");
          await sleep(DEFAULT_DIALOG_SETTLE_MS);
          break;
        }
        case "modal": {
          const pressed = await sendKeys(user, name, ["Escape"]);
          if (!pressed.ok) return pressed;
          dialogsAnswered.push("modal(Escape)");
          await sleep(DEFAULT_DIALOG_SETTLE_MS);
          break;
        }
        case "composer_ready":
          return { ok: true, value: { dialogsAnswered, readyMs: now() - started } };
        case "unknown":
          await sleep(readyPollIntervalMs);
          break;
      }

      if (dialogsAnswered.length >= MAX_DIALOGS_ANSWERED) {
        return fail("not_ready", `gave up after ${MAX_DIALOGS_ANSWERED} dialogs`, { pane: lastPane });
      }
    }
    return fail("not_ready", `no composer within ${readyTimeoutMs}ms`, { pane: lastPane });
  }

  async function newSession(request: NewSessionRequest): Promise<TmuxResult<NewSessionOutcome>> {
    const refused = guard(request.user, request.name);
    if (refused) return refused;

    const commandProblem = checkCommand(request.command);
    if (commandProblem) return fail("invalid_command", commandProblem.message);

    const env: Record<string, string> = { ...(request.env ?? {}) };
    if (request.configDir !== undefined) env.CLAUDE_CONFIG_DIR = request.configDir;
    const envProblem = checkEnv(env);
    if (envProblem) return fail("invalid_command", envProblem.message);

    const started = await tmux(
      request.user,
      newSessionArgs({
        name: request.name,
        cwd: request.cwd,
        command: request.command,
        env,
        cols: sessionCols,
        rows: sessionRows,
      }),
    );
    if (!started.ok) return started;

    // The ticket's "hasSession reports it within 2 s" criterion. It proves
    // the *session* started — nothing more. A trust dialog or an onboarding
    // modal sits behind a session tmux reports as perfectly alive, which is
    // why readiness below is a separate, longer wait against the composer.
    const visibleDeadline = now() + sessionVisibleTimeoutMs;
    let visible = false;
    for (;;) {
      const seen = await hasSession(request.user, request.name);
      if (!seen.ok) return seen;
      if (seen.value.exists) {
        visible = true;
        break;
      }
      if (now() >= visibleDeadline) break;
      await sleep(Math.min(readyPollIntervalMs, 100));
    }
    if (!visible) {
      return fail(
        "not_found",
        `tmux accepted new-session but has-session did not report ${request.name} within ${sessionVisibleTimeoutMs}ms — the pane command probably exited immediately`,
      );
    }

    if (request.waitForComposer === false) {
      return { ok: true, value: { name: request.name, dialogsAnswered: [], readyMs: null } };
    }

    const ready = await waitForComposer(request.user, request.name);
    if (!ready.ok) {
      // A session whose composer never came up is not usable and must not
      // be left behind as an orphan holding memory against ticket 018's
      // cap. The pane text is carried on the failure so the diagnosis
      // survives the kill.
      await killSession(request.user, request.name);
      return ready;
    }
    return {
      ok: true,
      value: {
        name: request.name,
        dialogsAnswered: ready.value.dialogsAnswered,
        readyMs: ready.value.readyMs,
      },
    };
  }

  return {
    newSession,
    hasSession,
    capturePane,
    sendKeys,
    sendLiteral,
    clearComposer,
    sendMessage,
    killSession,

    async sendEscape(user: string, name: string) {
      // Spike 002 §3: halts the turn and leaves the session alive, 3/3,
      // ~124 ms on WSL. Note what it does NOT do — a message queued before
      // the Escape survives it and runs immediately afterwards (3/3), and
      // the interrupted prompt is restored into the composer. Anything that
      // means "stop" rather than "stop and do the next thing I said" has to
      // drain its own queue; that is ticket 027's product decision, not
      // this adapter's.
      return sendKeys(user, name, ["Escape"]);
    },

    async listSessions(user: string) {
      const refused = guard(user);
      if (refused) return refused;
      const result = await tmux(user, listSessionsArgs());
      if (!result.ok) {
        // No server running means no sessions, not a failure.
        if (result.kind === "no_server") return { ok: true, value: { names: [], foreign: [] } };
        return result;
      }
      const all = result.value.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      return {
        ok: true,
        value: {
          names: all.filter((name) => isOfficeSessionName(name)),
          // Reported so a caller can see them, never acted on. Other people
          // have tmux sessions on this box and none of them is ours to
          // touch — and `kill-server` appears nowhere in this file.
          foreign: all.filter((name) => !isOfficeSessionName(name)),
        },
      };
    },
  };
}

// --- Default instance ---------------------------------------------------------

let cached: TmuxAdapter | undefined;

/**
 * Built lazily from `loadTmuxConfig()`, so importing this module does not
 * require the tmux environment variables to be set — the migration runner
 * and the event server both import parts of this package without ever
 * spawning an agent.
 */
export function getTmuxAdapter(): TmuxAdapter {
  if (cached === undefined) {
    const config = loadTmuxConfig();
    cached = createTmuxAdapter({
      agentUsers: config.agentUsers,
      sudoPath: config.sudoPath,
      tmuxPath: config.tmuxPath,
      commandTimeoutMs: config.commandTimeoutMs,
      readyTimeoutMs: config.readyTimeoutMs,
      maxMessageBytes: config.maxMessageBytes,
      sessionCols: config.sessionCols,
      sessionRows: config.sessionRows,
    });
  }
  return cached;
}

export function __resetForTests(): void {
  cached = undefined;
}
