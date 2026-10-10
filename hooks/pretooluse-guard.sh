#!/usr/bin/env bash
#
# hooks/pretooluse-guard.sh — the PreToolUse ownership guard's OUTAGE RECORD.
# Ticket 020.
#
#
# WHAT THIS SCRIPT IS AND IS NOT
# ==============================
# It is NOT the thing that blocks an edit. Spike 001 §2b measured an `http`
# hook blocking a live `PreToolUse` on build 2.1.278 — a 200 whose body
# carries `hookSpecificOutput.permissionDecision: "deny"` — so the decision is
# made by the http entry in config/hooks/fragments/pretooluse-guard.json,
# which pays sub-millisecond loopback transport and no process spawn. This
# script pays ~20 ms, almost all of it spawn, and would buy nothing by
# repeating that decision.
#
# What it buys is the one thing an http hook cannot do: **leave a record when
# the orchestrator is unreachable.** An http hook that cannot reach the server
# simply fails; it cannot write a file. This ticket's decided behaviour is to
# fail OPEN but never SILENTLY, so something on the agent's own box has to
# append the attempt to disk and flush it when the orchestrator comes back.
# That is this script, and that is the whole justification for its existence.
#
# Consequences of that split, stated plainly:
#
#   - This script **always exits 0** on its normal path. It is not a second
#     opinion on the edit.
#   - Its POST to `/guard/flush` is both the buffer drain AND the reachability
#     probe. It has no other way to learn the orchestrator is down than to
#     try, so it tries on every mutating tool call — and the attempt it makes
#     is the one that also drains the buffer. On the common path the buffer is
#     empty, the body is a 24-byte constant, and no `jq` is needed at all.
#   - `OFFICE_GUARD_ENFORCE=1` turns on a SECOND mode in which this script
#     also asks `/guard/check` and exits 2 on a refusal. It is OFF by default
#     because the http entry already blocks and enabling it doubles the
#     requests per tool call. It exists as the lever to pull if a future build
#     changes the blocking vocabulary again — the spike found the mapping is
#     per-event (`permissionDecision` is authoritative on `PreToolUse` and
#     inert on `UserPromptSubmit`), so "it blocks today" is not "it blocks
#     forever".
#
#
# THINGS THIS SCRIPT MUST NEVER DO, AND HOW EACH IS PREVENTED
# ===========================================================
#  1. **Never interpolate payload text into a command.** The payload is read
#     once into a variable and only ever reaches another process on STDIN
#     (`curl --data-binary @-`, `jq` with a fixed filter). No branch of this
#     script puts it in an argument, a URL, a filename or an eval. The only
#     values that reach a command line are environment variables the
#     orchestrator provisioned and strings this script generated.
#  2. **Never read or log file contents, only paths.** A `Write`'s
#     `tool_input.content` is the whole file body and an `Edit`'s
#     `old_string`/`new_string` are fragments of it. The jq filter names the
#     path fields it wants and nothing else; it never emits `.tool_input`
#     wholesale, and the raw payload is never written to disk. When jq is
#     missing the buffer records the attempt with NO path rather than grepping
#     one out of a blob that also contains the file's text.
#  3. **Never block the turn.** Every external call is bounded by
#     `--max-time`, the hook entry carries an explicit `"timeout": 2` (the
#     default is 30 s and spike 001 measured the turn held for all of it), and
#     every failure path ends in `exit 0`.
#  4. **Never grow without bound.** The buffer is capped and drops
#     OLDEST-first, recording how many it dropped in a sidecar file that the
#     next successful flush reports to the orchestrator.
#
#
# WHAT THE GUARD CANNOT COVER AT ALL — documented, not claimed
# ===========================================================
#   - **`!` bash mode bypasses `PreToolUse` entirely** (spike 001 §8.4). The
#     guard constrains the agent, not the session: anyone with the tmux pane
#     can run shell commands no hook ever sees.
#   - **`Bash` tool calls are not checked.** `tool_input` carries a `command`,
#     not a path, so `sed -i`, a redirect or `git checkout` are mutating
#     writes with nothing for the guard to compare.
#
#
# ENVIRONMENT
# ===========
# Provisioned into every agent session by 009's `agentLaunchSpec()`:
#   OFFICE_EVENT_SERVER_ORIGIN   https origin, no trailing slash
#   OFFICE_HOOK_INGEST_TOKEN     this account's ingest token
#   NODE_EXTRA_CA_CERTS          the CA curl must trust (self-signed certs are
#                                rejected without it — spike 001 §12)
#
# This script's own knobs, all optional:
#   OFFICE_GUARD_DIR              default $HOME/.office  (created 0700)
#   OFFICE_GUARD_BUFFER_MAX_LINES default 1000
#   OFFICE_GUARD_TIMEOUT_S        default 1   (must stay under the hook's 2 s)
#   OFFICE_GUARD_JQ               default jq
#   OFFICE_GUARD_CURL             default curl
#   OFFICE_GUARD_ENFORCE          default 0   (see above)
#
# A `command` hook gets NO shell profile — tmux runs it through a
# non-interactive shell, so ~/.bashrc never runs and ~/.local/bin is not on
# PATH. Name a binary by absolute path in OFFICE_GUARD_JQ / OFFICE_GUARD_CURL
# if it is not in the default PATH.
#
#
# INSTALLATION (a human step this script cannot self-certify)
# ===========================================================
# The design says to read every hook script before installing it, because
# hooks run shell commands on a box holding three people's logins. On the
# host this file must be mode 755 and owned by an account the AGENTS CANNOT
# WRITE TO — root, or the `office` service account — precisely so an agent
# cannot rewrite its own guard. The git checkout cannot express that (this
# repo records every .sh as 100644; `core.filemode` is false on the authoring
# machine), so it is set at install time, and that is a line this ticket owes
# to whoever runs provisioning.
#
# `jq` is a prerequisite for the outage path only. Install it with the rest of
# the host setup.

set -u

# --- Configuration -------------------------------------------------------------

payload="$(cat 2>/dev/null || true)"

origin="${OFFICE_EVENT_SERVER_ORIGIN:-}"
token="${OFFICE_HOOK_INGEST_TOKEN:-}"
cacert="${NODE_EXTRA_CA_CERTS:-}"
guard_dir="${OFFICE_GUARD_DIR:-${HOME:-/tmp}/.office}"
max_lines="${OFFICE_GUARD_BUFFER_MAX_LINES:-1000}"
timeout_s="${OFFICE_GUARD_TIMEOUT_S:-1}"
jq_bin="${OFFICE_GUARD_JQ:-jq}"
curl_bin="${OFFICE_GUARD_CURL:-curl}"
enforce="${OFFICE_GUARD_ENFORCE:-0}"

buffer="$guard_dir/guard-buffer.jsonl"
dropped_file="$guard_dir/guard-dropped"

# Both numbers reach a printf format argument and shell arithmetic, so a
# non-numeric value is replaced rather than passed through. An operator who
# typo'd one gets the default and a warning, not a broken guard.
case "$max_lines" in
  '' | *[!0-9]*)
    printf 'office-guard: OFFICE_GUARD_BUFFER_MAX_LINES is not a number; using 1000\n' >&2
    max_lines=1000
    ;;
esac
case "$timeout_s" in
  '' | *[!0-9.]*)
    printf 'office-guard: OFFICE_GUARD_TIMEOUT_S is not a number; using 1\n' >&2
    timeout_s=1
    ;;
esac

curl_args=(-fsS --max-time "$timeout_s" -H 'Content-Type: application/json' --data-binary @-)
if [ -n "$cacert" ]; then
  curl_args+=(--cacert "$cacert")
fi

last_curl_status=0

# --- Helpers -------------------------------------------------------------------

warn() {
  # stderr from a command hook is shown to the agent prefixed with this
  # script's path, so the text has to read sensibly behind
  # "[/path/to/pretooluse-guard.sh]: ".
  printf 'office-guard: %s\n' "$1" >&2
}

# Strip anything that would break a hand-built JSON string. Only ever applied
# to strings this script generated, never to payload text — payload text goes
# through jq or is not recorded at all.
json_safe() {
  # The two characters are named in OCTAL — \042 is `"` and \134 is `\` —
  # rather than written literally. A literal backslash inside a `tr` set has
  # to be doubled, and the doubled form reads as a quoting bug even when it is
  # correct (shellcheck says so, SC1003). Octal is unambiguous to both.
  printf '%s' "$1" | tr -d '\042\134' | tr -d '[:cntrl:]'
}

new_edit_id() {
  if [ -r /proc/sys/kernel/random/uuid ]; then
    tr -d '\n' < /proc/sys/kernel/random/uuid
    return 0
  fi
  # No /proc (not Linux, or a hardened container). The orchestrator stores the
  # edit id as text precisely so this fallback is storable: it only has to be
  # unique enough to make a repeated flush idempotent.
  printf 'g-%s-%s-%s%s' \
    "$(date -u +%s 2>/dev/null || printf '0')" "$$" "${RANDOM:-0}" "${RANDOM:-0}"
}

read_dropped() {
  local value
  value="$(cat "$dropped_file" 2>/dev/null || true)"
  case "$value" in
    '' | *[!0-9]*) value=0 ;;
  esac
  printf '%s' "$value"
}

# --- The buffer ----------------------------------------------------------------

trim_buffer() {
  local lines drop dropped
  lines="$(wc -l < "$buffer" 2>/dev/null || printf '0')"
  lines="${lines//[^0-9]/}"
  if [ -z "$lines" ]; then
    lines=0
  fi
  if [ "$lines" -le "$max_lines" ]; then
    return 0
  fi
  drop=$((lines - max_lines))
  # OLDEST first. The newest entries are the ones an operator is most likely
  # to still be able to act on, and an outage long enough to overflow this
  # buffer has already lost the argument about completeness — what must not
  # happen is that it fills a disk, or that the loss goes unrecorded.
  if tail -n "$max_lines" "$buffer" > "$buffer.trim" 2>/dev/null; then
    if mv "$buffer.trim" "$buffer" 2>/dev/null; then
      dropped="$(read_dropped)"
      printf '%s\n' "$((dropped + drop))" > "$dropped_file" 2>/dev/null || true
      warn "the guard buffer passed $max_lines lines; dropped $drop oldest entries"
    else
      rm -f "$buffer.trim" 2>/dev/null || true
    fi
  else
    rm -f "$buffer.trim" 2>/dev/null || true
  fi
}

# Appends THIS attempt to the buffer. $1 is why the guard could not check it.
buffer_attempt() {
  local reason edit_id at line
  reason="$1"
  edit_id="$(new_edit_id)"
  at="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || printf '')"

  line=''
  if command -v "$jq_bin" > /dev/null 2>&1; then
    # The payload reaches jq on STDIN and the filter is a literal. The filter
    # names the four path fields every checked tool uses and emits NOTHING
    # else from tool_input — no content, no old_string, no new_string.
    # shellcheck disable=SC2016  # $edit_id/$at/$reason are JQ variables bound
    # by --arg above, and MUST NOT be expanded by the shell: shell expansion
    # here is exactly how payload-adjacent text would end up inside a filter.
    line="$(printf '%s' "$payload" | "$jq_bin" -c \
      --arg edit_id "$edit_id" --arg at "$at" --arg reason "$reason" \
      '{
         edit_id: $edit_id,
         at: $at,
         reason: $reason,
         session_id: (.session_id? // null),
         cwd: (.cwd? // null),
         tool_name: (.tool_name? // null),
         tool_use_id: (.tool_use_id? // null),
         paths: ([
           (.tool_input.file_path?),
           (.tool_input.notebook_path?),
           (.tool_input.path?),
           (.tool_input.edits[]?.file_path?)
         ] | map(select(type == "string")) | unique)
       }' 2>/dev/null || true)"
  fi

  if [ -z "$line" ]; then
    # No jq, or a payload jq refused. Record the ATTEMPT with no path. This is
    # deliberately not a grep: `tool_input.content` can contain anything,
    # including text that looks exactly like a `"file_path": "..."` pair, and
    # a path guessed out of a file's body would be both wrong and a leak of
    # the content this guard exists to protect.
    line="$(printf '{"edit_id":"%s","at":"%s","reason":"%s","paths":[],"extract":"%s"}' \
      "$(json_safe "$edit_id")" \
      "$(json_safe "$at")" \
      "$(json_safe "$reason")" \
      'no path extracted: jq unavailable or payload unreadable')"
    warn 'no jq on this box: the unguarded edit was recorded without its file path'
  fi

  if ! printf '%s\n' "$line" >> "$buffer" 2>/dev/null; then
    # Nowhere to write. The LAST resort is stderr, which at least lands in the
    # agent's transcript, because an unguarded edit nobody can ever enumerate
    # is the one outcome this ticket's Decided section rules out.
    warn "could not write the guard buffer at $buffer; this edit is unrecorded: $reason"
    return 0
  fi
  chmod 600 "$buffer" 2>/dev/null || true
  trim_buffer
}

# --- The flush, which is also the probe ----------------------------------------

flush_buffer() {
  local spool dropped edits body
  spool=''
  dropped="$(read_dropped)"

  if [ -s "$buffer" ]; then
    # Claimed by rename, which is atomic: a concurrent run of this script
    # finds no buffer and sends an empty flush, rather than two runs posting
    # the same spool. Anything appended after the rename lands in a fresh
    # buffer and goes out with the next call.
    spool="$guard_dir/guard-spool.$$.jsonl"
    if ! mv "$buffer" "$spool" 2>/dev/null; then
      spool=''
    fi
  fi

  if [ -n "$spool" ] && [ -s "$spool" ]; then
    # Every line in the spool is one compact JSON object (jq -c wrote it, or
    # printf did), so a JSON array is the lines joined by commas. No jq needed
    # here, which matters: the recovery path must work on a box that never had
    # it.
    edits="$(tr '\n' ',' < "$spool" | sed 's/,*$//')"
    body="$(printf '{"dropped":%s,"edits":[%s]}' "$dropped" "$edits")"
  else
    body="$(printf '{"dropped":%s,"edits":[]}' "$dropped")"
  fi

  # The status is captured from the pipeline directly rather than read back
  # after an `if`. `$?` following a compound statement is the COMPOUND's
  # status — 0 whenever an `if` condition was merely false — so the obvious
  # spelling reported every outage as "curl exit 0". Caught by
  # guard-script.test.ts asserting on the recorded reason, which is the only
  # place that number is ever read.
  printf '%s' "$body" \
    | "$curl_bin" "${curl_args[@]}" -o /dev/null "$origin/guard/flush?token=$token"
  last_curl_status=$?

  if [ "$last_curl_status" -eq 0 ]; then
    if [ -n "$spool" ]; then
      # Cleared ONLY after the orchestrator acknowledged it. A lost ack costs
      # a repeated flush, which the server makes a no-op by edit id; a spool
      # deleted before the ack costs the record itself.
      rm -f "$spool" 2>/dev/null || true
    fi
    if [ "$dropped" != '0' ]; then
      printf '0\n' > "$dropped_file" 2>/dev/null || true
    fi
    return 0
  fi

  if [ -n "$spool" ] && [ -s "$spool" ]; then
    cat "$spool" >> "$buffer" 2>/dev/null || true
    rm -f "$spool" 2>/dev/null || true
  fi
  return 1
}

# --- Optional enforcement (OFF by default; see the header) ---------------------

enforce_check() {
  local verdict reason
  verdict="$(mktemp "$guard_dir/verdict.XXXXXX" 2>/dev/null || true)"
  if [ -z "$verdict" ]; then
    return 0
  fi

  if ! printf '%s' "$payload" \
    | "$curl_bin" "${curl_args[@]}" -o "$verdict" "$origin/guard/check?token=$token"; then
    # Unreachable or refused the token. Not a refusal of the edit — the flush
    # below records the outage.
    rm -f "$verdict" 2>/dev/null || true
    return 0
  fi

  # The server answers compact JSON, and a refusal carries BOTH blocking
  # fields (see guard-check.ts). Matching the top-level one, because
  # `"decision":"block"` is the shape the spike found blocked every event it
  # was tried on.
  if ! grep -q '"decision":"block"' "$verdict" 2>/dev/null; then
    rm -f "$verdict" 2>/dev/null || true
    return 0
  fi

  reason=''
  if command -v "$jq_bin" > /dev/null 2>&1; then
    reason="$("$jq_bin" -r '.reason // empty' "$verdict" 2>/dev/null || true)"
  fi
  if [ -z "$reason" ]; then
    reason='this file is owned by another active task (the orchestrator refused the edit; install jq for the full reason)'
  fi
  rm -f "$verdict" 2>/dev/null || true

  # Flush first: the buffer may hold an earlier outage, and a refusal is no
  # reason to keep sitting on it.
  flush_buffer || true
  warn "$reason"
  # Exit 2 is the `command`-hook refusal: it returns the message above to the
  # agent instead of letting the tool run.
  exit 2
}

# --- Main ----------------------------------------------------------------------

mkdir -p "$guard_dir" 2>/dev/null || true
chmod 700 "$guard_dir" 2>/dev/null || true

if [ -z "$origin" ] || [ -z "$token" ]; then
  # Provisioning gap rather than an outage, and it has the same effect: no
  # check happened. Recorded the same way, because the whole point of the
  # buffer is that the reason is written down rather than guessed at later.
  buffer_attempt 'the agent environment carries no OFFICE_EVENT_SERVER_ORIGIN or OFFICE_HOOK_INGEST_TOKEN, so the guard could not be asked'
  exit 0
fi

if [ "$enforce" = '1' ]; then
  enforce_check
fi

if flush_buffer; then
  exit 0
fi

buffer_attempt "the orchestrator did not answer POST /guard/flush (curl exit $last_curl_status)"
exit 0
