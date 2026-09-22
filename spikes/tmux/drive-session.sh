#!/usr/bin/env bash
#
# spikes/tmux/drive-session.sh — ticket 003 measurement harness
#
# Drives a live Claude Code TUI through tmux and prints one TSV row per trial, so the
# findings doc (docs/spikes/002-tmux-tui-control.md) can be filled from real numbers
# instead of hand-transcribed impressions.
#
# ---------------------------------------------------------------------------------
# THIS SCRIPT IS THE INSTRUMENT, NOT THE READING.
#
# It was written on a Windows host against a WSL Ubuntu, where the numbers that matter
# (timing, RSS, sudo behaviour) are not trustworthy.
#
# It HAS now been run there, against a live login: the findings doc carries a full set of
# WSL numbers, labelled as provisional in every section. They are not the target's. RSS
# under WSL2's memory accounting, timings against a Microsoft-patched kernel in a utility
# VM, and a tmux path with no `sudo` in it are all wrong for the VPS in ways nobody could
# see later. Ticket 007 re-runs this on the target and replaces those numbers.
#
# `sudo-parity` has still never executed: it needs the real accounts and sudoers file.
#
# Five bugs were found by running it. Four produced a plausible WRONG number rather than
# an error, which is the argument for not trusting an instrument that has not been used:
#   1. RE_READY matched one hint string that moves with the permission mode  -> everything
#      reported not_ready against a session that was up and taking input.
#   2. chars --mode echo verified via the PANE, which renders markdown       -> `backticks`
#      were reported mangled when they had arrived byte for byte. Reads the transcript now.
#   3. that check sampled its baseline AFTER submitting, behind a 2 s sleep  -> replies that
#      landed in under 2 s were scored as failures.
#   4. clear_composer() counted with `i`, the loop counter of its callers    -> --trials N
#      silently ran exactly one trial and reported success.
#   5. the "did the tool run" marker was hardcoded while its prompt is a var -> injected
#      messages that really did approve a tool call were labelled dismissed.
# ---------------------------------------------------------------------------------
#
# WHAT MUST BE SUPPLIED ON THE VPS
#
#   SPIKE_USER        The Linux user the agent runs as (the design's `gluy`). When set,
#                     every tmux call is wrapped as `sudo -n -u "$SPIKE_USER" /usr/bin/tmux`,
#                     which is exactly the call ticket 007's adapter will make. Leave it
#                     empty to drive tmux as the current user (no sudo in the path).
#   SPIKE_SUDO        Override the whole sudo prefix, e.g. "sudo -n -u gluy". Default is
#                     "sudo -n -u $SPIKE_USER" when SPIKE_USER is set, else empty.
#                     -n (non-interactive) is deliberate: a sudoers rule that needs a
#                     password must fail loudly here rather than hang on a prompt.
#   SPIKE_TMUX        Absolute path to tmux. Default /usr/bin/tmux — must match the path
#                     in /etc/sudoers.d/office byte for byte or sudo refuses.
#   SPIKE_PROJECT_DIR Working directory for the agent (a throwaway git repo, not this one).
#                     Must exist and be readable by SPIKE_USER. Default $HOME/spike003-tmp/proj.
#   SPIKE_CONFIG_DIR  CLAUDE_CONFIG_DIR for the agent, i.e. which login it uses. Must belong
#                     to SPIKE_USER. Empty means "whatever claude picks by default".
#   SPIKE_CLAUDE      The claude binary as seen by SPIKE_USER. Default `claude` (on PATH).
#   SPIKE_CLAUDE_ARGS Extra args, e.g. "--model sonnet". These trials spend real tokens;
#                     pick the cheapest model the VPS login allows.
#   SPIKE_TMPDIR      Scratch root. Default $HOME/spike003-tmp. Pane snapshots and hook logs
#                     land under $SPIKE_TMPDIR/run-<pid>/. When sudo is in the path this
#                     directory must be writable BY THE AGENT'S USER too (the SessionEnd
#                     hook script runs as SPIKE_USER) — chmod 0777 it or set it to a path
#                     under that user's home.
#
# ASSUMPTIONS
#   * Ubuntu 24.04-ish: bash, GNU coreutils (`date +%s%3N`), procps `ps`, awk, grep -E.
#     No jq, no node, no GNU-only flags beyond `date %N` and `ps --sort`(avoided).
#   * tmux >= 3.2 (needs `new-session -e`). Checked by `doctor`.
#   * The agent's login is already authenticated. An expired login shows up as
#     outcome=auth_failed on every row rather than as a fake measurement.
#   * Every session this script creates is named `spike003-*`. It never runs
#     `tmux kill-server` and never kills a session it did not create. Sessions belonging
#     to the human, or to a sibling agent, are left alone. `cleanup` is prefix-scoped.
#   * First-run dialogs block the prompt: the folder-trust question in a directory claude
#     has not seen, and whatever onboarding modal the current build ships (an auto-update
#     added "Try the new fullscreen renderer?" during this spike). The harness confirms
#     trust with Enter, cancels anything else with Escape, and reports every dialog it got
#     past in the `startup` row. `tmux has-session` is true the whole time a dialog is up,
#     so it is NOT a readiness signal — ticket 007's newSession has the same problem.
#
# USAGE
#   ./drive-session.sh doctor
#   ./drive-session.sh deliver --state idle|midturn|prompt|all [--trials 20]
#   ./drive-session.sh interrupt [--trials 20] [--with-queued]
#   ./drive-session.sh chars [--mode compose|echo]
#   ./drive-session.sh session-end [--trials 5] [--midturn]
#   ./drive-session.sh rss [--samples 20] [--interval 1] [--midturn]
#   ./drive-session.sh sudo-parity
#   ./drive-session.sh cleanup
#   ./drive-session.sh all [--trials 20]
#   any subcommand + --dry-run  → print the commands, launch nothing, spend nothing
#
# OUTPUT
#   Comment lines (`# ...`) carry the run's environment. Then a TSV header and one row
#   per trial on stdout; progress and errors go to stderr. Redirect stdout to a file and
#   paste it into the findings doc:
#       ./drive-session.sh all --trials 20 > ~/003-results.tsv 2> ~/003-run.log
#
set -euo pipefail

# ------------------------------------------------------------------ configuration

SPIKE_USER="${SPIKE_USER:-}"
SPIKE_TMUX="${SPIKE_TMUX:-/usr/bin/tmux}"
SPIKE_CLAUDE="${SPIKE_CLAUDE:-claude}"
SPIKE_CLAUDE_ARGS="${SPIKE_CLAUDE_ARGS:-}"
SPIKE_CONFIG_DIR="${SPIKE_CONFIG_DIR:-}"
SPIKE_TMPDIR="${SPIKE_TMPDIR:-$HOME/spike003-tmp}"
SPIKE_PROJECT_DIR="${SPIKE_PROJECT_DIR:-$SPIKE_TMPDIR/proj}"
if [ -n "$SPIKE_USER" ]; then
  SPIKE_SUDO="${SPIKE_SUDO:-sudo -n -u $SPIKE_USER}"
else
  SPIKE_SUDO="${SPIKE_SUDO:-}"
fi

SPIKE_TRIALS="${SPIKE_TRIALS:-20}"
SPIKE_COLS="${SPIKE_COLS:-200}"
SPIKE_ROWS="${SPIKE_ROWS:-50}"
SPIKE_POLL="${SPIKE_POLL:-0.1}"           # pane poll interval, seconds
SPIKE_READY_TIMEOUT="${SPIKE_READY_TIMEOUT:-90}"
SPIKE_REPLY_TIMEOUT="${SPIKE_REPLY_TIMEOUT:-180}"
SPIKE_TURN_TIMEOUT="${SPIKE_TURN_TIMEOUT:-300}"
SPIKE_HOOK_TIMEOUT="${SPIKE_HOOK_TIMEOUT:-15}"
SPIKE_MIDTURN_DELAY="${SPIKE_MIDTURN_DELAY:-4}"   # seconds into a turn before acting
SPIKE_SEND_GAP="${SPIKE_SEND_GAP:-0.3}"           # pause between text and Enter
SPIKE_KEEP="${SPIKE_KEEP:-0}"                     # 1 = leave sessions up for inspection

# A turn long enough to act against, that needs no tools and no permission prompt.
SPIKE_LONG_PROMPT="${SPIKE_LONG_PROMPT:-Without using any tools, count from 1 to 60. Put each number on its own line with a short sentence about it.}"
# A prompt that should raise a permission request (no tool is pre-approved in step 1).
# NOTE: 2.1.278 runs `echo` with NO dialog at all — it classifies some commands as safe
# enough not to ask, with no allowlist involved. Use a WRITE to reach the dialog, e.g.
#   SPIKE_PERMISSION_PROMPT='Use the Bash tool to run: touch /tmp/spike003-permission-probe'
SPIKE_PERMISSION_PROMPT="${SPIKE_PERMISSION_PROMPT:-Use the Bash tool to run: echo spike003-permission-probe}"
# Proof-of-execution marker looked for in the pane. This MUST track SPIKE_PERMISSION_PROMPT:
# it was hardcoded, so overriding the prompt silently broke the dialog_answered branch and
# three trials in which the injected message really did approve the tool were reported as
# `dialog_dismissed` / `changed_other`. Pick a marker that appears only when the tool RUNS,
# not one that is already in the command text the dialog itself displays.
SPIKE_PERMISSION_MARKER="${SPIKE_PERMISSION_MARKER:-spike003-permission-probe}"

# TUI state markers. Version-sensitive — checked and reported by `doctor`. Observed on
# Claude Code 2.1.278; 2.1.178 auto-updated to it mid-spike and grew a new blocking modal,
# so verify these strings against the build actually installed before trusting a run.
# The hint line under the composer reads "? for shortcuts" ONLY while the permission mode is
# the default. With any mode active it is replaced by "<mode> on (shift+tab to cycle)" —
# observed on 2.1.278 with auto mode on, where a session whose composer was up and accepting
# input was reported as a 90 s startup timeout. Match the mode line too.
RE_READY='\? for shortcuts|shift\+tab to cycle'
RE_BUSY='esc to interrupt'
RE_TRUST='trust this folder|Is this a project you created or one you trust'
# Any other first-run / onboarding modal. Observed in the wild: an auto-update to 2.1.278
# introduced "Try the new fullscreen renderer?", which blocks the prompt indefinitely.
# Unknown modals are cancelled with Escape rather than confirmed — confirming an unknown
# dialog can change the renderer out from under capture-pane.
RE_MODAL='Enter to confirm|Esc to cancel'
RE_PERMISSION='Do you want to|Yes, and don.t ask again|Allow this tool|1\. Yes'
RE_AUTH_FAIL='Please run /login|OAuth access token is invalid|Invalid API key|Credit balance is too low'
RE_INTERRUPTED='Interrupted by user|Interrupted ·|Request interrupted'

PREFIX="spike003"
RUN_ID="$$"
DRY_RUN=0
RUNDIR="$SPIKE_TMPDIR/run-$RUN_ID"
SESSION_LIST="$RUNDIR/sessions"
HEADER_DONE=0

# ------------------------------------------------------------------ small helpers

log()  { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
die()  { printf 'error: %s\n' "$*" >&2; exit 2; }
now_ms() { date +%s%3N; }
iso()  { date -u +%Y-%m-%dT%H:%M:%SZ; }

# Flatten a value so it cannot break the TSV.
flat() { printf '%s' "${1:-}" | tr '\t\n\r' '   ' | cut -c1-300; }

emit_header() {
  [ "$HEADER_DONE" = "1" ] && return 0
  HEADER_DONE=1
  printf '# spike 003 — tmux control of a live Claude Code TUI\n'
  printf '# run_id\t%s\n' "$RUN_ID"
  printf '# started\t%s\n' "$(iso)"
  printf '# host\t%s\n' "$(uname -srm 2>/dev/null || echo unknown)"
  printf '# os\t%s\n' "$( . /etc/os-release 2>/dev/null && printf '%s' "${PRETTY_NAME:-unknown}" || printf 'unknown')"
  printf '# tmux\t%s\n' "$($SPIKE_TMUX -V 2>/dev/null || echo missing)"
  printf '# claude\t%s\n' "$(${SPIKE_CLAUDE} --version 2>/dev/null || echo missing)"
  printf '# sudo_prefix\t%s\n' "${SPIKE_SUDO:-(none)}"
  printf '# target_user\t%s\n' "${SPIKE_USER:-$(id -un)}"
  printf '# project_dir\t%s\n' "$SPIKE_PROJECT_DIR"
  printf '# config_dir\t%s\n' "${SPIKE_CONFIG_DIR:-(default)}"
  printf '# claude_args\t%s\n' "${SPIKE_CLAUDE_ARGS:-(none)}"
  printf '# rundir\t%s\n' "$RUNDIR"
  printf 'ts\ttest\ttrial\tvariant\toutcome\tvalue\tunit\tdetail\n'
}

# emit <test> <trial> <variant> <outcome> <value> <unit> <detail>
emit() {
  emit_header
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$(iso)" "$1" "$2" "$3" "$4" "${5:--}" "${6:--}" "$(flat "${7:-}")"
}

plan() { printf '%s\n' "$*"; }

dry_header() {
  printf '# DRY RUN — no session is started, no tokens are spent.\n'
  printf '# tmux prefix : %s%s\n' "${SPIKE_SUDO:+$SPIKE_SUDO }" "$SPIKE_TMUX"
  printf '# project dir : %s\n' "$SPIKE_PROJECT_DIR"
  printf '# launch cmd  : %s\n' "$(launch_cmd)"
  printf '\n'
}

# ------------------------------------------------------------------ tmux plumbing

# All tmux traffic goes through here, so the sudo wrapper is applied in exactly one place.
tmux_raw() {
  if [ -n "$SPIKE_SUDO" ]; then
    # shellcheck disable=SC2086
    $SPIKE_SUDO "$SPIKE_TMUX" "$@"
  else
    "$SPIKE_TMUX" "$@"
  fi
}

launch_cmd() {
  printf '%s' "$SPIKE_CLAUDE"
  [ -n "$SPIKE_CLAUDE_ARGS" ] && printf ' %s' "$SPIKE_CLAUDE_ARGS"
  printf '\n'
}

session_name() { printf '%s-%s-%s' "$PREFIX" "$1" "$RUN_ID"; }

register_session() { printf '%s\n' "$1" >> "$SESSION_LIST"; }

# start_agent <session> [extra claude args...]
start_agent() {
  s="$1"; shift
  cmd="$(launch_cmd | tr -d '\n')"
  [ $# -gt 0 ] && cmd="$cmd $*"
  register_session "$s"
  if [ -n "$SPIKE_CONFIG_DIR" ]; then
    tmux_raw new-session -d -s "$s" -x "$SPIKE_COLS" -y "$SPIKE_ROWS" \
      -c "$SPIKE_PROJECT_DIR" -e "CLAUDE_CONFIG_DIR=$SPIKE_CONFIG_DIR" "$cmd"
  else
    tmux_raw new-session -d -s "$s" -x "$SPIKE_COLS" -y "$SPIKE_ROWS" \
      -c "$SPIKE_PROJECT_DIR" "$cmd"
  fi
  log "started session $s: $cmd"
}

has_session() { tmux_raw has-session -t "$1" 2>/dev/null; }

pane() { tmux_raw capture-pane -p -t "$1" 2>/dev/null || true; }

# Pane plus scrollback, for finding a reply that has scrolled off.
pane_hist() { tmux_raw capture-pane -p -S -400 -t "$1" 2>/dev/null || true; }

snapshot() { # snapshot <session> <label>
  mkdir -p "$RUNDIR/panes"
  pane_hist "$1" > "$RUNDIR/panes/$2.txt" 2>/dev/null || true
}

matches() { printf '%s' "$1" | grep -qE "$2"; }
contains() { printf '%s' "$1" | grep -qF -- "$2"; }

# The TUI is drawn with box characters; define them as bytes so grep/awk can find them
# without depending on the locale.
RULE_CHAR="$(printf '\342\224\200')"    # ─ the input box's horizontal rules
PROMPT_CHAR="$(printf '\342\235\257')"  # ❯ the composer's cursor marker
NBSP_CHAR="$(printf '\302\240')"        # the TUI pads with U+00A0, not a plain space
RE_PLACEHOLDER='^Try "'                 # the composer's own hint text, i.e. it is empty

# composer_text <session> — just the text sitting in the input box, with the ❯ marker and
# padding stripped. Reading the whole pane instead is how a check ends up passing on text
# that was actually submitted a minute ago and is still on screen.
composer_text() {
  pane "$1" | awk -v rule="$RULE_CHAR" -v pr="$PROMPT_CHAR" -v nb="$NBSP_CHAR" '
    { lines[NR]=$0; if (index($0, rule) > 0) { r2=r1; r1=NR } }
    END {
      if (r2 == 0 || r1 == 0) exit
      for (i=r2+1; i<r1; i++) {
        l = lines[i]
        sub(pr, "", l)    # regex from a variable: mawk and gawk disagree about substr()
                          # on a multibyte marker, sub() on the raw bytes does not.
        gsub(nb, " ", l)  # the TUI pads the composer with U+00A0, which [ \t] never trims
        sub(/^[ \t]*/, "", l); sub(/[ \t]*$/, "", l)
        print l
      }
    }'
}

# hist_count <session> <literal> — how many times the string appears in the pane ABOVE the
# composer, i.e. as submitted history. Counting the whole pane would count the draft the
# harness just typed and call every trial a premature submit.
hist_count() {
  total="$(pane_hist "$1" | grep -cF -- "$2" || true)"
  inbox="$(composer_text "$1" | grep -cF -- "$2" || true)"
  printf '%s' "$(( ${total:-0} - ${inbox:-0} ))"
}

kill_session() { tmux_raw kill-session -t "$1" 2>/dev/null || true; }

# Only ever kills sessions this run created.
cleanup_run() {
  [ "$SPIKE_KEEP" = "1" ] && { log "SPIKE_KEEP=1 — leaving sessions up"; return 0; }
  [ -f "$SESSION_LIST" ] || return 0
  while IFS= read -r s; do
    [ -z "$s" ] && continue
    if has_session "$s"; then
      log "cleanup: killing $s"
      kill_session "$s"
    fi
  done < "$SESSION_LIST"
}

# ------------------------------------------------------------------ TUI readiness

# wait_ready <session> -> 0 ready, 1 timeout, 3 auth failure
# Answers the folder-trust dialog (Enter) and cancels any other first-run modal (Escape),
# recording each one in READY_DIALOGS. Dialogs are the reason a naive "sleep 5 then send"
# adapter is wrong: the prompt is not there yet, and the keystrokes answer a dialog instead.
READY_DIALOGS=""
wait_ready() {
  s="$1"; deadline=$(( $(date +%s) + SPIKE_READY_TIMEOUT )); READY_DIALOGS=""; answered=0
  while [ "$(date +%s)" -lt "$deadline" ]; do
    p="$(pane "$s")"
    if matches "$p" "$RE_AUTH_FAIL"; then return 3; fi
    # Dialogs are tested BEFORE readiness. The composer's hint line can still be on screen
    # underneath a modal, so checking readiness first sends the opening message into the
    # dialog instead of the prompt — the exact failure ticket 007's newSession must avoid.
    if matches "$p" "$RE_TRUST"; then
      tmux_raw send-keys -t "$s" Enter
      READY_DIALOGS="$READY_DIALOGS trust(Enter)"
      answered=$(( answered + 1 ))
      log "answered the folder-trust dialog in $s"
      sleep 1.5
    elif matches "$p" "$RE_MODAL"; then
      title="$(printf '%s' "$p" | grep -E '\?[[:space:]]*$' | head -n 1 | sed -e 's/^[[:space:]]*//' || true)"
      tmux_raw send-keys -t "$s" Escape
      READY_DIALOGS="$READY_DIALOGS modal[${title:-unlabelled}](Esc)"
      answered=$(( answered + 1 ))
      log "cancelled an onboarding modal in $s: ${title:-unlabelled}"
      sleep 1.5
    elif matches "$p" "$RE_READY"; then
      return 0
    else
      sleep "$SPIKE_POLL"
    fi
    if [ "$answered" -ge 10 ]; then
      log "gave up after 10 dialogs in $s"
      return 1
    fi
  done
  return 1
}

# ensure_ready <session> <test-name> -> 0 when the prompt is up. Emits the startup row,
# including which dialogs stood between launch and a usable prompt.
ensure_ready() {
  s="$1"; t="$2"
  if wait_ready "$s"; then
    emit "$t" 0 startup ready - - "prompt reached${READY_DIALOGS:+; dialogs answered:$READY_DIALOGS}"
    return 0
  fi
  rc=$?
  snapshot "$s" "$t-startup-failed"
  if [ "$rc" = "3" ]; then
    emit "$t" 0 startup auth_failed - - "the login was rejected — every row below would have been fiction${READY_DIALOGS:+; dialogs answered:$READY_DIALOGS}"
  else
    emit "$t" 0 startup not_ready - - "no prompt within ${SPIKE_READY_TIMEOUT}s${READY_DIALOGS:+; dialogs answered:$READY_DIALOGS}; pane: $RUNDIR/panes/$t-startup-failed.txt"
  fi
  kill_session "$s"
  return 1
}

is_busy() { matches "$(pane "$1")" "$RE_BUSY"; }

# wait_busy <session> <timeout_s>
wait_busy() {
  deadline=$(( $(date +%s) + $2 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    is_busy "$1" && return 0
    sleep "$SPIKE_POLL"
  done
  return 1
}

# wait_idle <session> <timeout_s>
wait_idle() {
  deadline=$(( $(date +%s) + $2 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    is_busy "$1" || return 0
    sleep "$SPIKE_POLL"
  done
  return 1
}

# wait_text <session> <literal> <timeout_s> -> prints elapsed ms, returns 0/1
wait_text() {
  s="$1"; needle="$2"; t0="$(now_ms)"; deadline=$(( $(date +%s) + $3 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if contains "$(pane_hist "$s")" "$needle"; then
      printf '%s' "$(( $(now_ms) - t0 ))"; return 0
    fi
    sleep "$SPIKE_POLL"
  done
  printf '%s' "$(( $(now_ms) - t0 ))"; return 1
}

# ------------------------------------------------------------------ message sending
#
# Three mechanisms, because which one survives special characters is the question:
#   keys    tmux send-keys "<text>" Enter        — tmux PARSES the text as key names
#   literal tmux send-keys -l -- "<text>"        — sent verbatim, Enter sent separately
#   buffer  tmux load-buffer - ; paste-buffer    — verbatim, survives newlines, one write
#
send_text() { # send_text <session> <mechanism> <text>
  s="$1"; mech="$2"; txt="$3"
  case "$mech" in
    keys)    tmux_raw send-keys -t "$s" "$txt" ;;
    literal) tmux_raw send-keys -t "$s" -l -- "$txt" ;;
    buffer)  printf '%s' "$txt" | tmux_raw load-buffer -b "${PREFIX}buf" - \
               && tmux_raw paste-buffer -d -b "${PREFIX}buf" -t "$s" ;;
    buffer-bracket)
             printf '%s' "$txt" | tmux_raw load-buffer -b "${PREFIX}buf" - \
               && tmux_raw paste-buffer -d -p -b "${PREFIX}buf" -t "$s" ;;
    *) die "unknown send mechanism: $mech" ;;
  esac
}

submit() { sleep "$SPIKE_SEND_GAP"; tmux_raw send-keys -t "$1" Enter; }

# C-u clears ONE line of the composer, so a multi-line draft needs several. Escape does
# not clear it (measured); C-c does, but a second C-c exits Claude Code, so C-u is safer.
#
# The counter is _cc_i, NOT i. sh has no function scope: this used `i`, and every trial
# loop that calls it at the end of a trial also counts with `i`, so the call left i=4 and
# the loop exited after ONE trial while reporting success. `interrupt --trials 3` silently
# ran a single trial; `deliver --state prompt --trials 20` would have done the same.
clear_composer() {
  _cc_i=0
  while [ "$_cc_i" -lt 4 ]; do
    tmux_raw send-keys -t "$1" C-u 2>/dev/null || true
    _cc_i=$(( _cc_i + 1 ))
  done
  sleep 0.3
}

# send_message <session> <text>  — the normal path: literal text, then Enter
send_message() {
  send_text "$1" "${SPIKE_SEND_MECHANISM:-literal}" "$2"
  submit "$1"
}

# The reply token must NOT appear verbatim in the prompt, or the harness matches the
# echoed user message and reports a 14 ms round trip from an agent that never answered.
# So the prompt carries the digits and the agent assembles the token.
token() { printf '%s%s' "$RUN_ID" "$1"; }
ack_expect() { printf 'ACK%s' "$1"; }
ack_prompt() {
  printf 'Reply with exactly the three capital letters ACK followed immediately by the characters %s, with no space between them and nothing else in the reply. Do not use any tools.' "$1"
}

# ------------------------------------------------------------------ 1. delivery trials
#
# Acceptance criterion: does send-keys "<text>" Enter reliably deliver a message when the
# agent is idle, mid-turn, or sitting at a permission prompt — 20 trials each, with the
# observed failure count for each state. Plus: what happens to a mid-turn message —
# queued, dropped, or interleaved into the prompt box.

deliver_idle() {
  trials="$1"
  s="$(session_name deliver-idle)"
  start_agent "$s"
  ensure_ready "$s" deliver-idle || return 0
  i=1
  while [ "$i" -le "$trials" ]; do
    tk="$(token "i$i")"; exp="$(ack_expect "$tk")"
    send_message "$s" "$(ack_prompt "$tk")"
    if ms="$(wait_text "$s" "$exp" "$SPIKE_REPLY_TIMEOUT")"; then
      emit deliver-idle "$i" idle ok "$ms" ms "reply carried $exp"
    else
      p="$(pane "$s")"
      if contains "$(composer_text "$s")" "Reply with exactly"; then
        out=stuck_in_composer; note="text sat in the composer, Enter did not submit it"
      elif matches "$p" "$RE_AUTH_FAIL"; then
        out=auth_failed; note="login rejected — no measurement"
      else
        out=timeout; note="no token within ${SPIKE_REPLY_TIMEOUT}s"
      fi
      snapshot "$s" "deliver-idle-$i"
      emit deliver-idle "$i" idle "$out" "$ms" ms "$note"
    fi
    wait_idle "$s" "$SPIKE_TURN_TIMEOUT" || true
    i=$(( i + 1 ))
  done
  kill_session "$s"
}

deliver_midturn() {
  trials="$1"
  s="$(session_name deliver-mid)"
  start_agent "$s"
  ensure_ready "$s" deliver-midturn || return 0
  i=1
  while [ "$i" -le "$trials" ]; do
    send_message "$s" "$SPIKE_LONG_PROMPT"
    if ! wait_busy "$s" 60; then
      emit deliver-midturn "$i" midturn no_turn - - "long prompt never entered a turn"
      i=$(( i + 1 )); continue
    fi
    sleep "$SPIKE_MIDTURN_DELAY"
    tk="$(token "m$i")"; exp="$(ack_expect "$tk")"
    t0="$(now_ms)"
    send_message "$s" "$(ack_prompt "$tk")"
    # Classify: does the token arrive while still busy (interleaved / new turn),
    # after the turn ends (queued), or never (dropped)?
    seen_during=0; ended_ms=""; got_ms=""
    deadline=$(( $(date +%s) + SPIKE_TURN_TIMEOUT ))
    while [ "$(date +%s)" -lt "$deadline" ]; do
      p="$(pane_hist "$s")"
      if [ -z "$got_ms" ] && contains "$p" "$exp"; then
        got_ms=$(( $(now_ms) - t0 ))
        [ -z "$ended_ms" ] && seen_during=1
      fi
      if [ -z "$ended_ms" ] && ! matches "$p" "$RE_BUSY"; then
        ended_ms=$(( $(now_ms) - t0 ))
      fi
      [ -n "$got_ms" ] && [ -n "$ended_ms" ] && break
      sleep "$SPIKE_POLL"
    done
    snapshot "$s" "deliver-midturn-$i"
    if [ -n "$got_ms" ] && [ "$seen_during" = "1" ]; then
      emit deliver-midturn "$i" midturn interleaved "$got_ms" ms "token appeared while the first turn was still running; turn end at ${ended_ms:-?}ms"
    elif [ -n "$got_ms" ]; then
      emit deliver-midturn "$i" midturn queued "$got_ms" ms "delivered after turn end (${ended_ms}ms); queue latency $(( got_ms - ${ended_ms:-0} ))ms"
    else
      p="$(composer_text "$s")"
      if contains "$p" "Reply with exactly"; then
        emit deliver-midturn "$i" midturn stuck_in_composer "$ended_ms" ms "text is sitting in the composer unsent"
      else
        emit deliver-midturn "$i" midturn dropped "$ended_ms" ms "turn ended, token never appeared"
      fi
    fi
    wait_idle "$s" "$SPIKE_TURN_TIMEOUT" || true
    i=$(( i + 1 ))
  done
  kill_session "$s"
}

deliver_prompt() {
  trials="$1"
  s="$(session_name deliver-perm)"
  start_agent "$s"
  ensure_ready "$s" deliver-prompt || return 0
  i=1
  while [ "$i" -le "$trials" ]; do
    send_message "$s" "$SPIKE_PERMISSION_PROMPT"
    # Wait for the permission dialog.
    got_dialog=0; deadline=$(( $(date +%s) + 120 ))
    while [ "$(date +%s)" -lt "$deadline" ]; do
      matches "$(pane "$s")" "$RE_PERMISSION" && { got_dialog=1; break; }
      sleep "$SPIKE_POLL"
    done
    if [ "$got_dialog" = "0" ]; then
      emit deliver-prompt "$i" permission no_dialog - - "no permission dialog appeared — check the allowlist and SPIKE_PERMISSION_PROMPT"
      wait_idle "$s" "$SPIKE_TURN_TIMEOUT" || true
      i=$(( i + 1 )); continue
    fi
    before="$(pane "$s")"
    snapshot "$s" "deliver-prompt-$i-before"
    tk="$(token "p$i")"; exp="$(ack_expect "$tk")"
    t0="$(now_ms)"
    send_message "$s" "$(ack_prompt "$tk")"
    sleep 3
    after="$(pane "$s")"
    snapshot "$s" "deliver-prompt-$i-after"
    # The dangerous outcome is dialog_answered: keystrokes selected an option. The design
    # forbids keystroke injection for prompts precisely because of this; measure whether
    # an ordinary chat message can trip it.
    if ! matches "$after" "$RE_PERMISSION"; then
      if contains "$after" "$SPIKE_PERMISSION_MARKER"; then
        emit deliver-prompt "$i" permission dialog_answered "$(( $(now_ms) - t0 ))" ms "DANGER: the message dismissed the dialog and the tool ran"
      else
        emit deliver-prompt "$i" permission dialog_dismissed "$(( $(now_ms) - t0 ))" ms "dialog disappeared without the tool running"
      fi
    elif contains "$after" "$exp"; then
      emit deliver-prompt "$i" permission answered_and_replied "$(( $(now_ms) - t0 ))" ms "DANGER: the dialog went away and the agent answered the injected message"
    elif contains "$after" "$tk"; then
      emit deliver-prompt "$i" permission text_into_dialog "$(( $(now_ms) - t0 ))" ms "dialog still up, message text visible inside it"
    elif [ "$before" = "$after" ]; then
      emit deliver-prompt "$i" permission ignored "$(( $(now_ms) - t0 ))" ms "pane unchanged — keystrokes went nowhere visible"
    else
      emit deliver-prompt "$i" permission changed_other "$(( $(now_ms) - t0 ))" ms "dialog still up but pane changed; see $RUNDIR/panes/deliver-prompt-$i-after.txt"
    fi
    # Leave the dialog in a known state for the next trial: Escape cancels it.
    tmux_raw send-keys -t "$s" Escape
    sleep 1
    clear_composer "$s"
    wait_idle "$s" 60 || true
    i=$(( i + 1 ))
  done
  kill_session "$s"
}

cmd_deliver() {
  state=all; trials="$SPIKE_TRIALS"
  while [ $# -gt 0 ]; do
    case "$1" in
      --state) state="$2"; shift 2 ;;
      --trials) trials="$2"; shift 2 ;;
      *) die "deliver: unknown flag $1" ;;
    esac
  done
  if [ "$DRY_RUN" = "1" ]; then
    dry_header
    plan "deliver --state $state --trials $trials would run, per state:"
    plan ""
    plan "  idle:"
    plan "    ${SPIKE_SUDO:+$SPIKE_SUDO }$SPIKE_TMUX new-session -d -s $(session_name deliver-idle) -x $SPIKE_COLS -y $SPIKE_ROWS -c $SPIKE_PROJECT_DIR${SPIKE_CONFIG_DIR:+ -e CLAUDE_CONFIG_DIR=$SPIKE_CONFIG_DIR} '$(launch_cmd)'"
    plan "    (poll capture-pane until /$RE_READY/, answering the trust dialog with Enter)"
    plan "    x$trials: send-keys -l -- 'Reply with exactly <TOKEN> ...' ; send-keys Enter"
    plan "              poll capture-pane -S -400 until <TOKEN> appears or ${SPIKE_REPLY_TIMEOUT}s"
    plan ""
    plan "  midturn:"
    plan "    send-keys the long prompt, wait for /$RE_BUSY/, sleep ${SPIKE_MIDTURN_DELAY}s,"
    plan "    then send the token message and classify queued | interleaved | dropped | stuck_in_composer"
    plan ""
    plan "  prompt (permission dialog):"
    plan "    send '$SPIKE_PERMISSION_PROMPT', wait for /$RE_PERMISSION/,"
    plan "    then send the token message and classify dialog_answered | text_into_dialog | ignored"
    plan "    (dialog_answered is the outcome the design's no-keystroke-injection rule is about)"
    plan ""
    plan "  every state ends with: $SPIKE_TMUX kill-session -t spike003-*-$RUN_ID"
    return 0
  fi
  case "$state" in
    idle) deliver_idle "$trials" ;;
    midturn) deliver_midturn "$trials" ;;
    prompt) deliver_prompt "$trials" ;;
    all) deliver_idle "$trials"; deliver_midturn "$trials"; deliver_prompt "$trials" ;;
    *) die "deliver: unknown state $state" ;;
  esac
}

# ------------------------------------------------------------------ 2. interrupt timing
#
# Acceptance criterion: does send-keys Escape halt the current turn without killing the
# session, and how long does it take to take effect. --with-queued also answers ticket
# 027's open question: what happens to a message queued but not yet delivered when the
# turn is interrupted.

cmd_interrupt() {
  trials="$SPIKE_TRIALS"; with_queued=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --trials) trials="$2"; shift 2 ;;
      --with-queued) with_queued=1; shift ;;
      *) die "interrupt: unknown flag $1" ;;
    esac
  done
  if [ "$DRY_RUN" = "1" ]; then
    dry_header
    plan "interrupt --trials $trials$([ "$with_queued" = "1" ] && printf ' --with-queued') would run:"
    plan "  new-session -d -s $(session_name interrupt) ... '$(launch_cmd)'"
    plan "  x$trials:"
    plan "    send the long prompt; wait for /$RE_BUSY/; sleep ${SPIKE_MIDTURN_DELAY}s"
    [ "$with_queued" = "1" ] && plan "    send a token message mid-turn (queued, undelivered)"
    plan "    t0 = date +%s%3N ; ${SPIKE_SUDO:+$SPIKE_SUDO }$SPIKE_TMUX send-keys -t <session> Escape"
    plan "    poll capture-pane every ${SPIKE_POLL}s until /$RE_BUSY/ clears  -> escape_to_idle ms"
    plan "    has-session -t <session>                                       -> session survived?"
    [ "$with_queued" = "1" ] && plan "    then wait ${SPIKE_REPLY_TIMEOUT}s for the queued token: delivered | discarded"
    return 0
  fi
  s="$(session_name interrupt)"
  start_agent "$s"
  ensure_ready "$s" interrupt || return 0
  i=1
  while [ "$i" -le "$trials" ]; do
    send_message "$s" "$SPIKE_LONG_PROMPT"
    if ! wait_busy "$s" 60; then
      emit interrupt "$i" escape no_turn - - "long prompt never entered a turn"
      i=$(( i + 1 )); continue
    fi
    sleep "$SPIKE_MIDTURN_DELAY"
    tk=""
    if [ "$with_queued" = "1" ]; then
      tk="$(token "q$i")"; exp="$(ack_expect "$tk")"
      send_message "$s" "$(ack_prompt "$tk")"
      sleep 1
    fi
    t0="$(now_ms)"
    tmux_raw send-keys -t "$s" Escape
    if wait_idle "$s" 60; then
      ms=$(( $(now_ms) - t0 ))
      if has_session "$s"; then
        note="turn halted, session alive"
        matches "$(pane "$s")" "$RE_INTERRUPTED" && note="$note, pane shows an interrupted marker"
        emit interrupt "$i" escape ok "$ms" ms "$note"
      else
        emit interrupt "$i" escape session_died "$ms" ms "Escape ended the session — kill semantics, not interrupt"
      fi
    else
      emit interrupt "$i" escape no_effect - - "still busy 60s after Escape"
    fi
    snapshot "$s" "interrupt-$i"
    if [ "$with_queued" = "1" ]; then
      if qms="$(wait_text "$s" "$exp" 60)"; then
        emit interrupt "$i" queued-after-escape delivered "$qms" ms "the message queued before Escape still ran — 027 must decide if that is wanted"
      else
        emit interrupt "$i" queued-after-escape discarded "$qms" ms "the queued message did not produce a reply after the interrupt"
      fi
    fi
    wait_idle "$s" "$SPIKE_TURN_TIMEOUT" || true
    clear_composer "$s"
    i=$(( i + 1 ))
  done
  kill_session "$s"
}

# ------------------------------------------------------------------ 3. character matrix
#
# Acceptance criterion: a double quote, a single quote, a backtick, a dollar sign, a
# semicolon, a newline and a non-ASCII character are sent, and the doc records what the
# agent actually received, plus the working invocation verbatim.
#
# Two modes:
#   compose (default, free) — type the string into the composer, read it back off the
#            pane, never press Enter. Measures what tmux delivered to the TUI.
#   echo    (spends tokens) — submit it and ask the agent to echo it back. Measures what
#            the agent actually received, which is what ticket 007 must guarantee.

char_variants() {
  cat <<'VARIANTS'
dquote	she said "hello" to me
squote	it's an agent's job
backtick	run `whoami` now
dollar	cost is $HOME and $(id -u)
semicolon	first; rm -rf ~; second
shellmeta	a|b&c>d<e*f?g[h]i{j}k
nonascii	café naïve 你好 — ✅
newline	line one\nline two
combined	"quoted" 'single' `tick` $VAR ; semi café
VARIANTS
}

# The table above holds real UTF-8 for the non-ASCII variant and a literal \n for the
# newline variant; %b turns the \n into a real newline and leaves everything else alone.
expand() { printf '%b' "$1"; }

# --- echo-mode ground truth: the transcript, not the pane ------------------------------
#
# THE PANE CANNOT ANSWER THIS CRITERION. The TUI renders both the user message and the
# reply as markdown, so a payload containing `backticks` is drawn with the backticks
# stripped: `run \`whoami\` now` is displayed as "run whoami now". A grep of capture-pane
# then reports a payload that arrived perfectly intact as mangled. Measured on 2.1.278.
#
# Claude Code's own JSONL transcript records the user message verbatim, which is exactly
# the question the ticket asks — "what the agent actually received" — and it records the
# reply too, so delivery and echo can be told apart.
#
# Note the transcript file does NOT exist until the first message is submitted (measured),
# so it is re-resolved on every poll rather than cached at session start.

transcript_file() {
  root="${SPIKE_CONFIG_DIR:-$HOME/.claude}/projects"
  slug="$(printf '%s' "$SPIKE_PROJECT_DIR" | sed -e 's/[\/.]/-/g')"
  ls -t "$root/$slug"/*.jsonl 2>/dev/null | head -n 1
}

# json_escape <text> — reproduce what JSON.stringify did to the payload on its way into the
# transcript: backslash, double quote, and a real newline into a literal \n. Every other
# character in this matrix — backtick, $, ;, shell metacharacters, UTF-8 — is stored
# literally, so grep -F on the escaped form is an exact test.
json_escape() {
  printf '%s' "$1" \
    | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' \
    | awk '{ printf "%s%s", sep, $0; sep="\\n" } END { printf "\n" }'
}

# transcript_count <file> <user|assistant> <text> — lines of that role holding the payload
# byte for byte. Filtering by role matters: the transcript also carries a `last-prompt`
# bookkeeping line with the same text, which would inflate a naive count.
transcript_count() {
  f="$1"; kind="$2"
  { [ -n "$f" ] && [ -f "$f" ]; } || { printf '0'; return 0; }
  needle="$(json_escape "$3")"
  case "$kind" in
    user) pat='"type":"user"' ;;
    *)    pat='"role":"assistant"' ;;
  esac
  c="$(grep -F -- "$pat" "$f" 2>/dev/null | grep -cF -- "$needle" || true)"
  printf '%s' "${c:-0}"
}

cmd_chars() {
  mode=compose
  while [ $# -gt 0 ]; do
    case "$1" in
      --mode) mode="$2"; shift 2 ;;
      *) die "chars: unknown flag $1" ;;
    esac
  done
  if [ "$DRY_RUN" = "1" ]; then
    dry_header
    plan "chars --mode $mode would test each variant against each mechanism:"
    plan ""
    plan "  mechanisms"
    plan "    keys           $SPIKE_TMUX send-keys -t <s> '<text>'            (tmux parses key names — expected to mangle)"
    plan "    literal        $SPIKE_TMUX send-keys -t <s> -l -- '<text>'      (verbatim)"
    plan "    buffer         printf %s '<text>' | $SPIKE_TMUX load-buffer -b spike003buf - ; $SPIKE_TMUX paste-buffer -d -b spike003buf -t <s>"
    plan "    buffer-bracket same, with paste-buffer -p (bracketed paste)"
    plan ""
    plan "  variants"
    char_variants | while IFS="$(printf '\t')" read -r name raw; do
      plan "    $name	$raw"
    done
    plan ""
    if [ "$mode" = "compose" ]; then
      plan "  compose mode: send, capture-pane, grep -F for the expected string, then C-u to clear."
      plan "  No Enter is pressed and no tokens are spent."
    else
      plan "  echo mode: submit 'Repeat exactly between markers: <<<TEXT>>>' and grep the reply."
      plan "  This spends tokens — one turn per variant per mechanism."
    fi
    return 0
  fi

  s="$(session_name chars)"
  start_agent "$s"
  ensure_ready "$s" chars || return 0
  n=0
  char_variants | while IFS="$(printf '\t')" read -r name raw; do
    expected="$(expand "$raw")"
    for mech in keys literal buffer buffer-bracket; do
      n=$(( n + 1 ))
      clear_composer "$s"
      sleep 0.2
      # Count how often the payload's first line is already on screen, so a submit caused
      # by the mechanism itself can be told from one left over from an earlier trial.
      first="$(printf '%s' "$expected" | head -n 1)"
      seen_before="$(hist_count "$s" "$first")"
      if ! send_text "$s" "$mech" "$expected" 2>"$RUNDIR/send-err.txt"; then
        emit chars "$n" "$name/$mech" send_failed - - "$(head -c 200 "$RUNDIR/send-err.txt" 2>/dev/null)"
        continue
      fi
      sleep 0.6
      p="$(pane "$s")"
      snapshot "$s" "chars-$name-$mech"
      if [ "$mode" = "compose" ]; then
        got="$(composer_text "$s")"
        seen_after="$(hist_count "$s" "$first")"
        if [ "$got" = "$expected" ]; then
          emit chars "$n" "$name/$mech" intact - - "composer holds the string byte for byte"
        elif [ "${seen_after:-0}" -gt "${seen_before:-0}" ]; then
          # The mechanism pressed Enter for us — a newline inside a payload acts as a
          # submit, so the agent receives half a message. This is the failure ticket 007's
          # encoding has to make impossible.
          emit chars "$n" "$name/$mech" submitted_early - - "'$first' was sent as a turn by the send mechanism; composer left holding [$got]"
        elif [ -z "$got" ] || matches "$got" "$RE_PLACEHOLDER"; then
          emit chars "$n" "$name/$mech" vanished - - "nothing in the composer and nothing on screen; snapshot: $RUNDIR/panes/chars-$name-$mech.txt"
        else
          emit chars "$n" "$name/$mech" mangled - - "got [$got] wanted [$expected]"
        fi
        clear_composer "$s"
      else
        # Echo mode: submit it and ask for it back, then read the TRANSCRIPT, not the pane
        # (see the comment above transcript_file — markdown rendering makes the pane lie).
        # Baselines are taken before the submit and reset if a new transcript file appears,
        # which is what happens on the first trial: the file is created by the first submit.
        mark="$(transcript_file)"
        ubase="$(transcript_count "$mark" user "$expected")"
        abase="$(transcript_count "$mark" assistant "$expected")"
        tmux_raw send-keys -t "$s" -l -- " <- repeat the text before this arrow back to me exactly once, with nothing else."
        submit "$s"
        t0="$(now_ms)"; got_user=0; got_asst=0
        deadline=$(( $(date +%s) + SPIKE_REPLY_TIMEOUT ))
        while [ "$(date +%s)" -lt "$deadline" ]; do
          tf="$(transcript_file)"
          if [ "$tf" != "$mark" ]; then mark="$tf"; ubase=0; abase=0; fi
          [ "$(transcript_count "$mark" user "$expected")" -gt "${ubase:-0}" ] && got_user=1
          if [ "$(transcript_count "$mark" assistant "$expected")" -gt "${abase:-0}" ]; then
            got_asst=1; break
          fi
          sleep "$SPIKE_POLL"
        done
        ms=$(( $(now_ms) - t0 ))
        snapshot "$s" "chars-echo-$name-$mech"
        if [ "$got_asst" = "1" ]; then
          emit chars "$n" "$name/$mech" echoed_intact "$ms" ms "transcript: the agent received the payload byte for byte and echoed it back byte for byte"
        elif [ "$got_user" = "1" ]; then
          emit chars "$n" "$name/$mech" received_echo_differs "$ms" ms "transcript: the user message carried the payload byte for byte; the reply did not repeat it exactly (an agent-wording issue, not a delivery one)"
        else
          emit chars "$n" "$name/$mech" not_received "$ms" ms "transcript: NO user message carried the payload byte for byte — the send mechanism mangled or split it; snapshot: $RUNDIR/panes/chars-echo-$name-$mech.txt"
        fi
        wait_idle "$s" "$SPIKE_TURN_TIMEOUT" || true
      fi
    done
  done
  # Buffer-limit probe: ticket 007 needs the size at which a message stops arriving whole.
  for size in 1000 4000 16000 65536; do
    clear_composer "$s"
    big="$(awk -v n="$size" 'BEGIN{s="";for(i=0;i<n;i++)s=s "x";print s}')"
    marker="ZZ${size}ZZ"
    if printf '%s%s' "$marker" "$big" | tmux_raw load-buffer -b "${PREFIX}buf" - 2>/dev/null \
       && tmux_raw paste-buffer -d -b "${PREFIX}buf" -t "$s" 2>/dev/null; then
      sleep 1.5
      got="$(composer_text "$s")"
      if contains "$got" "$marker"; then
        emit chars 0 "size-$size/buffer" accepted "$size" chars "composer shows the marker; length on screen $(printf '%s' "$got" | wc -c) bytes"
      elif matches "$got" 'Pasted text|\[Pasted'; then
        # A large paste collapses into a placeholder. The composer no longer shows the
        # text, so only echo mode can prove the whole payload survived.
        emit chars 0 "size-$size/buffer" collapsed_to_placeholder "$size" chars "composer shows [$got] — verify with chars --mode echo"
      elif [ -z "$got" ] || matches "$got" "$RE_PLACEHOLDER"; then
        emit chars 0 "size-$size/buffer" lost "$size" chars "composer empty after the paste"
      else
        emit chars 0 "size-$size/buffer" partial "$size" chars "composer holds something else: [$(printf '%s' "$got" | cut -c1-80)]"
      fi
    else
      emit chars 0 "size-$size/buffer" send_failed "$size" chars "load-buffer or paste-buffer refused this size"
    fi
    clear_composer "$s"
  done
  kill_session "$s"
}

# ------------------------------------------------------------------ 4. kill-session -> SessionEnd
#
# Acceptance criterion: does tmux kill-session reliably fire SessionEnd — this decides
# whether lock release may depend on it in ticket 015.
#
# Uses a throwaway settings file passed with --settings, so nothing global is touched.
# The hook is a `command` hook writing a timestamped line; the event server does not
# exist yet (ticket 005), and this measures the hook firing, not the transport.

write_hook_harness() {
  mkdir -p "$RUNDIR"
  cat > "$RUNDIR/hook-log.sh" <<'HOOKEOF'
#!/bin/sh
# Appends: <epoch_ms> <event> <first 400 bytes of the payload on stdin>
log="$(dirname "$0")/hooks.log"
printf '%s %s ' "$(date +%s%3N)" "$1" >> "$log"
head -c 400 >> "$log"
printf '\n' >> "$log"
HOOKEOF
  chmod 0755 "$RUNDIR/hook-log.sh"
  : > "$RUNDIR/hooks.log"
  chmod 0666 "$RUNDIR/hooks.log"
  cat > "$RUNDIR/settings.json" <<SETTINGSEOF
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "$RUNDIR/hook-log.sh SessionStart" }] }],
    "SessionEnd":   [{ "hooks": [{ "type": "command", "command": "$RUNDIR/hook-log.sh SessionEnd" }] }],
    "Stop":         [{ "hooks": [{ "type": "command", "command": "$RUNDIR/hook-log.sh Stop" }] }]
  }
}
SETTINGSEOF
  chmod 0644 "$RUNDIR/settings.json"
}

cmd_session_end() {
  trials=5; midturn=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --trials) trials="$2"; shift 2 ;;
      --midturn) midturn=1; shift ;;
      *) die "session-end: unknown flag $1" ;;
    esac
  done
  if [ "$DRY_RUN" = "1" ]; then
    dry_header
    plan "session-end --trials $trials$([ "$midturn" = "1" ] && printf ' --midturn') would:"
    plan "  write $RUNDIR/hook-log.sh and $RUNDIR/settings.json (SessionStart, SessionEnd, Stop -> a log line)"
    plan "  NOTE: under sudo those files are read and written by \$SPIKE_USER, not by the caller."
    plan "  x$trials:"
    plan "    new-session -d -s $(session_name sessend) ... '$(launch_cmd) --settings $RUNDIR/settings.json'"
    plan "    wait for /$RE_READY/"
    [ "$midturn" = "1" ] && plan "    send the long prompt and wait for /$RE_BUSY/ so the kill lands mid-turn"
    plan "    t0 = date +%s%3N ; ${SPIKE_SUDO:+$SPIKE_SUDO }$SPIKE_TMUX kill-session -t <session>"
    plan "    poll $RUNDIR/hooks.log for a SessionEnd line, up to ${SPIKE_HOOK_TIMEOUT}s"
    plan "    -> outcome fired | not_fired, value = kill-to-hook ms, detail = the payload's reason field"
    plan "  This is the evidence ticket 015 needs before lock release may depend on SessionEnd."
    return 0
  fi
  write_hook_harness
  i=1
  while [ "$i" -le "$trials" ]; do
    s="$(session_name "sessend-$i")"
    before="$(grep -c 'SessionEnd' "$RUNDIR/hooks.log" 2>/dev/null || true)"; before="${before:-0}"
    start_agent "$s" "--settings $RUNDIR/settings.json"
    if ! ensure_ready "$s" session-end; then i=$(( i + 1 )); continue; fi
    state=idle
    if [ "$midturn" = "1" ]; then
      send_message "$s" "$SPIKE_LONG_PROMPT"
      wait_busy "$s" 60 && state=midturn
      sleep "$SPIKE_MIDTURN_DELAY"
    fi
    t0="$(now_ms)"
    tmux_raw kill-session -t "$s"
    fired=0; ms=""
    deadline=$(( $(date +%s) + SPIKE_HOOK_TIMEOUT ))
    while [ "$(date +%s)" -lt "$deadline" ]; do
      now_count="$(grep -c 'SessionEnd' "$RUNDIR/hooks.log" 2>/dev/null || true)"; now_count="${now_count:-0}"
      if [ "$now_count" -gt "$before" ]; then fired=1; ms=$(( $(now_ms) - t0 )); break; fi
      sleep "$SPIKE_POLL"
    done
    line="$(grep 'SessionEnd' "$RUNDIR/hooks.log" 2>/dev/null | tail -n 1 || true)"
    if [ "$fired" = "1" ]; then
      emit session-end "$i" "$state" fired "$ms" ms "$line"
    else
      emit session-end "$i" "$state" not_fired "$SPIKE_HOOK_TIMEOUT" s "no SessionEnd within the timeout — ticket 015 cannot rely on this path alone"
    fi
    i=$(( i + 1 ))
  done
  log "hook log: $RUNDIR/hooks.log"
}

# ------------------------------------------------------------------ 5. RSS sampling
#
# Acceptance criterion: observed RSS for one idle claude process and one mid-turn one, as
# input to the per-project cap defaults in ticket 018.
#
# Sums the whole pane process tree, not just the claude pid: a claude process spawns
# helpers, and the cap has to be set against what the box actually loses per agent.

tree_rss_kb() { # tree_rss_kb <root pid>
  ps -eo pid=,ppid=,rss= 2>/dev/null | awk -v root="$1" '
    { pid[NR]=$1; ppid[NR]=$2; rss[NR]=$3; n=NR }
    END {
      inset[root]=1; changed=1
      while (changed) {
        changed=0
        for (i=1; i<=n; i++) if (!inset[pid[i]] && inset[ppid[i]]) { inset[pid[i]]=1; changed=1 }
      }
      total=0
      for (i=1; i<=n; i++) if (inset[pid[i]]) total += rss[i]
      print total
    }'
}

cmd_rss() {
  samples=20; interval=1; midturn=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --samples) samples="$2"; shift 2 ;;
      --interval) interval="$2"; shift 2 ;;
      --midturn) midturn=1; shift ;;
      *) die "rss: unknown flag $1" ;;
    esac
  done
  if [ "$DRY_RUN" = "1" ]; then
    dry_header
    plan "rss --samples $samples --interval $interval$([ "$midturn" = "1" ] && printf ' --midturn') would:"
    plan "  new-session -d -s $(session_name rss) ... '$(launch_cmd)'"
    plan "  pid=\$($SPIKE_TMUX list-panes -t <session> -F '#{pane_pid}')"
    plan "  x$samples every ${interval}s: ps -eo pid,ppid,rss -> sum of pid and every descendant"
    plan "    -> one row per sample, variant=idle, unit=KB"
    [ "$midturn" = "1" ] && plan "  then send the long prompt and sample again, variant=midturn, plus a peak row"
    plan ""
    plan "  NOTE: RSS under sudo -u reads the same /proc, so no privilege is needed to sample."
    plan "  NOTE: on WSL2 these numbers are not comparable to a bare VPS — this must run on the target."
    return 0
  fi
  s="$(session_name rss)"
  start_agent "$s"
  ensure_ready "$s" rss || return 0
  pid="$(tmux_raw list-panes -t "$s" -F '#{pane_pid}' | head -n 1)"
  emit rss 0 pane_pid info "$pid" pid "$(ps -o args= -p "$pid" 2>/dev/null | cut -c1-120)"
  i=1; peak=0
  while [ "$i" -le "$samples" ]; do
    kb="$(tree_rss_kb "$pid")"
    [ -n "$kb" ] && [ "$kb" -gt "$peak" ] && peak="$kb"
    emit rss "$i" idle sample "$kb" KB "process tree total"
    sleep "$interval"
    i=$(( i + 1 ))
  done
  emit rss 0 idle peak "$peak" KB "highest idle sample over $samples samples"
  if [ "$midturn" = "1" ]; then
    send_message "$s" "$SPIKE_LONG_PROMPT"
    if wait_busy "$s" 60; then
      i=1; mpeak=0
      while [ "$i" -le "$samples" ]; do
        kb="$(tree_rss_kb "$pid")"
        [ -n "$kb" ] && [ "$kb" -gt "$mpeak" ] && mpeak="$kb"
        emit rss "$i" midturn sample "$kb" KB "process tree total during a turn"
        is_busy "$s" || { emit rss "$i" midturn turn_ended - - "turn finished after $i samples"; break; }
        sleep "$interval"
        i=$(( i + 1 ))
      done
      emit rss 0 midturn peak "$mpeak" KB "highest mid-turn sample"
    else
      emit rss 0 midturn no_turn - - "the long prompt never entered a turn"
    fi
  fi
  # Whole-box context, so the cap can be reasoned about against real capacity.
  if [ -r /proc/meminfo ]; then
    emit rss 0 host memtotal "$(awk '/^MemTotal:/{print $2}' /proc/meminfo)" KB "MemTotal from /proc/meminfo"
    emit rss 0 host memavailable "$(awk '/^MemAvailable:/{print $2}' /proc/meminfo)" KB "MemAvailable at sample time — ticket 018's floor reads this"
  fi
  kill_session "$s"
}

# ------------------------------------------------------------------ 6. sudo -u parity
#
# Acceptance criterion: does `sudo -u <user> tmux ...` run from the office account behave
# identically to running as that user directly, including how $HOME and CLAUDE_CONFIG_DIR
# resolve. Cannot be answered anywhere but the VPS, with the real sudoers file in place.

cmd_sudo_parity() {
  if [ "$DRY_RUN" = "1" ]; then
    dry_header
    plan "sudo-parity would check, as the office user, with SPIKE_USER=<agent user>:"
    plan "  1. sudo -n -u \$SPIKE_USER true                      -> is the NOPASSWD rule in place at all"
    plan "  2. sudo -n -u \$SPIKE_USER $SPIKE_TMUX -V            -> is /usr/bin/tmux the permitted path"
    plan "  3. sudo -n -u \$SPIKE_USER $SPIKE_TMUX display-message -p '#{socket_path}'"
    plan "     -> confirms a per-user tmux server: office's own sessions are invisible to the agent user"
    plan "  4. a session running 'sh -c \"id -un; printenv HOME; printenv CLAUDE_CONFIG_DIR || echo (unset); pwd\"'"
    plan "     compared against getent passwd \$SPIKE_USER  -> does \$HOME follow the target user"
    plan "  5. the same with -e CLAUDE_CONFIG_DIR=...  vs inline 'CLAUDE_CONFIG_DIR=... claude'"
    plan "     -> which of the two forms actually reaches the process (the design uses the inline form)"
    plan "  6. sudo -n -u \$SPIKE_USER $SPIKE_TMUX kill-session -t <a session owned by office>"
    plan "     -> asserts cross-user isolation: it must FAIL"
    plan ""
    plan "  Without a passwordless sudoers rule every row is emitted as outcome=skipped."
    return 0
  fi
  if [ -z "$SPIKE_USER" ]; then
    emit sudo-parity 0 preconditions skipped - - "SPIKE_USER is not set — run this on the VPS as the office user with SPIKE_USER=<agent user>"
    return 0
  fi
  # Probe with tmux, NOT with `true`. deploy/host/sudoers.d/office grants
  # exactly /usr/bin/tmux and nothing else, so a CORRECTLY scoped rule
  # denies `sudo -n -u <user> true` — and probing with it made this whole
  # test skip every row against a working host, reporting "no passwordless
  # rule" and pointing the operator at the one file that was right.
  if ! sudo -n -u "$SPIKE_USER" "$SPIKE_TMUX" -V >/dev/null 2>&1; then
    emit sudo-parity 0 nopasswd skipped - - "sudo -n -u $SPIKE_USER $SPIKE_TMUX -V failed: no passwordless rule, a password is required, or the rule grants a different tmux path"
    return 0
  fi
  emit sudo-parity 1 nopasswd ok - - "sudo -n -u $SPIKE_USER $SPIKE_TMUX -V succeeded"
  v="$(sudo -n -u "$SPIKE_USER" "$SPIKE_TMUX" -V 2>&1 || true)"
  emit sudo-parity 2 tmux_path "$(printf '%s' "$v" | grep -q '^tmux' && echo ok || echo failed)" - - "$v"
  sock="$(sudo -n -u "$SPIKE_USER" "$SPIKE_TMUX" display-message -p '#{socket_path}' 2>&1 || true)"
  mysock="$($SPIKE_TMUX display-message -p '#{socket_path}' 2>&1 || true)"
  if [ "$sock" = "$mysock" ]; then
    emit sudo-parity 3 socket shared - - "same socket ($sock) — the two users share a tmux server; check this before trusting isolation"
  else
    emit sudo-parity 3 socket per_user - - "agent=$sock office=$mysock"
  fi
  s="$(session_name sudoenv)"
  register_session "$s"
  sudo -n -u "$SPIKE_USER" "$SPIKE_TMUX" new-session -d -s "$s" -x "$SPIKE_COLS" -y "$SPIKE_ROWS" \
    ${SPIKE_CONFIG_DIR:+-e "CLAUDE_CONFIG_DIR=$SPIKE_CONFIG_DIR"} \
    "sh -c 'id -un; printenv HOME; printenv CLAUDE_CONFIG_DIR || echo \"(unset)\"; pwd; sleep 30'" || true
  sleep 2
  out="$(sudo -n -u "$SPIKE_USER" "$SPIKE_TMUX" capture-pane -p -t "$s" 2>/dev/null | grep -v '^$' || true)"
  who="$(printf '%s' "$out" | sed -n '1p')"
  home="$(printf '%s' "$out" | sed -n '2p')"
  cfg="$(printf '%s' "$out" | sed -n '3p')"
  expected_home="$(getent passwd "$SPIKE_USER" | cut -d: -f6)"
  emit sudo-parity 4 whoami "$([ "$who" = "$SPIKE_USER" ] && echo ok || echo mismatch)" - - "pane reports '$who', expected '$SPIKE_USER'"
  emit sudo-parity 5 home "$([ "$home" = "$expected_home" ] && echo ok || echo mismatch)" - - "HOME='$home', passwd says '$expected_home'"
  emit sudo-parity 6 config_dir "$([ -n "$cfg" ] && echo present || echo absent)" - - "CLAUDE_CONFIG_DIR='$cfg' (set with new-session -e)"
  sudo -n -u "$SPIKE_USER" "$SPIKE_TMUX" kill-session -t "$s" 2>/dev/null || true
  # Cross-user isolation: a session owned by the caller must not be killable via the rule.
  own="$(session_name ownedbyoffice)"
  register_session "$own"
  "$SPIKE_TMUX" new-session -d -s "$own" 'sleep 30' 2>/dev/null || true
  if sudo -n -u "$SPIKE_USER" "$SPIKE_TMUX" kill-session -t "$own" 2>/dev/null; then
    emit sudo-parity 7 isolation leaked - - "the agent user's tmux could kill a session owned by the caller"
  else
    emit sudo-parity 7 isolation ok - - "the agent user's tmux cannot see the caller's sessions"
  fi
  "$SPIKE_TMUX" kill-session -t "$own" 2>/dev/null || true
}

# ------------------------------------------------------------------ doctor and cleanup

cmd_doctor() {
  emit_header
  for b in "$SPIKE_TMUX" ps awk grep sed; do
    if command -v "$b" >/dev/null 2>&1 || [ -x "$b" ]; then
      emit doctor 0 "bin:$(basename "$b")" ok - - "$(command -v "$b" 2>/dev/null || printf '%s' "$b")"
    else
      emit doctor 0 "bin:$(basename "$b")" missing - - "required"
    fi
  done
  if command -v "$SPIKE_CLAUDE" >/dev/null 2>&1; then
    emit doctor 0 bin:claude ok - - "$(command -v "$SPIKE_CLAUDE") $(${SPIKE_CLAUDE} --version 2>/dev/null)"
  else
    emit doctor 0 bin:claude missing - - "SPIKE_CLAUDE=$SPIKE_CLAUDE not on PATH"
  fi
  ms="$(date +%s%3N 2>/dev/null || true)"
  case "$ms" in
    *N*|"") emit doctor 0 date_ms missing - - "date +%s%3N is not supported — millisecond timings will be wrong" ;;
    *) emit doctor 0 date_ms ok "$ms" ms "millisecond clock available" ;;
  esac
  tv="$($SPIKE_TMUX -V 2>/dev/null || echo none)"
  emit doctor 0 tmux_version info - - "$tv (needs >= 3.2 for new-session -e)"
  if [ -d "$SPIKE_PROJECT_DIR" ]; then
    emit doctor 0 project_dir ok - - "$SPIKE_PROJECT_DIR"
  else
    emit doctor 0 project_dir missing - - "$SPIKE_PROJECT_DIR does not exist — create a throwaway repo there"
  fi
  if [ -n "$SPIKE_USER" ]; then
    # Probed with tmux rather than `true`: the scoped sudoers rule permits
    # only $SPIKE_TMUX, so `true` is denied on a correctly configured host.
    if sudo -n -u "$SPIKE_USER" "$SPIKE_TMUX" -V >/dev/null 2>&1; then
      emit doctor 0 sudo ok - - "passwordless sudo to $SPIKE_USER for $SPIKE_TMUX works"
    else
      emit doctor 0 sudo unavailable - - "sudo -n -u $SPIKE_USER $SPIKE_TMUX -V failed — sudo-parity and every sudo-path row will be skipped"
    fi
  else
    emit doctor 0 sudo not_configured - - "SPIKE_USER empty: tmux runs as $(id -un), which is NOT what the VPS will do"
  fi
  n="$(tmux_raw list-sessions -F '#{session_name}' 2>/dev/null | grep -c "^$PREFIX-" || true)"
  emit doctor 0 stale_sessions info "${n:-0}" count "existing $PREFIX-* sessions; run cleanup to remove them"
  emit doctor 0 markers info - - "ready=/$RE_READY/ busy=/$RE_BUSY/ — verify against the installed Claude Code version before trusting any row"
}

cmd_cleanup() {
  if [ "$DRY_RUN" = "1" ]; then
    dry_header
    plan "cleanup would run:"
    plan "  ${SPIKE_SUDO:+$SPIKE_SUDO }$SPIKE_TMUX list-sessions -F '#{session_name}' | grep '^$PREFIX-'"
    plan "  and kill-session each match. Sessions not matching $PREFIX-* are never touched,"
    plan "  and kill-server is never used."
    return 0
  fi
  emit_header
  found=0
  for s in $(tmux_raw list-sessions -F '#{session_name}' 2>/dev/null | grep "^$PREFIX-" || true); do
    found=$(( found + 1 ))
    kill_session "$s"
    emit cleanup "$found" "$s" killed - - "prefix-scoped cleanup"
  done
  [ "$found" = "0" ] && emit cleanup 0 none nothing_to_do - - "no $PREFIX-* sessions present"
  return 0
}

cmd_all() {
  trials="$SPIKE_TRIALS"
  while [ $# -gt 0 ]; do
    case "$1" in
      --trials) trials="$2"; shift 2 ;;
      *) die "all: unknown flag $1" ;;
    esac
  done
  cmd_doctor
  cmd_rss --samples 20 --interval 1 --midturn
  cmd_deliver --state all --trials "$trials"
  cmd_interrupt --trials "$trials" --with-queued
  cmd_chars --mode compose
  cmd_chars --mode echo
  cmd_session_end --trials 5
  cmd_session_end --trials 5 --midturn
  cmd_sudo_parity
}

# The header comment block IS the help text — stop at the first line of actual code.
usage() {
  sed -n '2,/^set -euo pipefail/p' "$0" | sed -e '$d' | sed -e 's/^# \{0,1\}//'
}

# ------------------------------------------------------------------ entry point

main() {
  [ $# -eq 0 ] && { usage; exit 1; }
  sub="$1"; shift
  # Pull --dry-run out of the argument list without disturbing the rest (rotation keeps
  # quoting intact, unlike rebuilding a string).
  n=$#; i=0
  while [ "$i" -lt "$n" ]; do
    a="$1"; shift
    if [ "$a" = "--dry-run" ]; then DRY_RUN=1; else set -- "$@" "$a"; fi
    i=$(( i + 1 ))
  done

  case "$sub" in
    -h|--help|help) usage; exit 0 ;;
  esac

  mkdir -p "$RUNDIR"
  : > "$SESSION_LIST"
  if [ "$DRY_RUN" = "1" ]; then
    :
  else
    trap cleanup_run EXIT INT TERM
    emit_header
  fi

  case "$sub" in
    doctor)      cmd_doctor "$@" ;;
    deliver)     cmd_deliver "$@" ;;
    interrupt)   cmd_interrupt "$@" ;;
    chars)       cmd_chars "$@" ;;
    session-end) cmd_session_end "$@" ;;
    rss)         cmd_rss "$@" ;;
    sudo-parity) cmd_sudo_parity "$@" ;;
    cleanup)     cmd_cleanup "$@" ;;
    all)         cmd_all "$@" ;;
    *) die "unknown subcommand '$sub' — try --help" ;;
  esac
}

main "$@"
