#!/bin/sh
# run-016.sh — spike 016's four remaining measurements, staged for the VPS.
#
# §8 of docs/spikes/003-mcp-wiring.md lists them. Two of the four need NO
# interactive session at all, which is the point of this script: it was written
# after discovering that `claude mcp list` health-checks servers and spawns
# stdio ones, so the probe's own log answers them without spending the human's
# single-session login.
#
#   PHASE A — no session, no tokens, safe to re-run:
#     A1  Does Claude Code's MCP client honour NODE_EXTRA_CA_CERTS?
#         The one that would OVERTURN the spike's HTTP recommendation. Run it
#         first. Spike 001 §12 measured the *hook* client rejecting a
#         self-signed cert outright; this is a different client in the same
#         process and "very probably identical" is how that shipped once.
#     A2  Is CLAUDE_CODE_SESSION_ID set in an MCP server's environment?
#         If yes the office gets model-invisible session identity for free and
#         GLU-55 shrinks. Only CLAUDE_PROJECT_DIR is documented as auto-set, so
#         this is a lead, not a finding, until this runs.
#
#   PHASE B — needs ONE interactive session, spends tokens:
#     B1  Does an isError tool result's TEXT reach the model usefully?
#     B2  Do the office's tools prompt under permissionMode manual with an
#         empty allowlist, and does mcp__office_tasks__* silence it while
#         "mcp__*" does not?
#
# Phase B is NOT automated here, deliberately. Driving a live TUI is ticket
# 007's machinery (spikes/tmux/drive-session.sh, 69 KB of it) and
# re-implementing it inside 016 would duplicate another ticket's work and give
# the office two TUI drivers to keep correct. Phase B prints the exact steps
# and the exact strings to grep for instead.
#
# RUN AS THE AGENT ACCOUNT (agent1), NOT as office and NOT through sudo.
# Legitimate only for this reading: the probe log and the agent transcript live
# under the agent's own 0700 directories, and office cannot traverse them. That
# is the isolation working, not a bug — spike 002 recorded the same thing about
# `chars --mode echo`. A probe needing access the boundary exists to refuse is
# not a test of the boundary.
set -eu

PROBE="${PROBE:-$HOME/probe-server.mjs}"
OUT="${OUT:-$HOME/016-mcp}"
# The project directory must be one this account already trusts, or the session
# parks on the folder-trust dialog and Enter does not clear it.
PROJECT="${PROJECT:-/srv/office/projects/throwaway}"
SERVER_NAME="${SERVER_NAME:-office-probe}"
CERT="${CERT:-/srv/office/tls/dev-cert.pem}"
# Set to an https URL of an MCP endpoint on the office cert to run A1 for real.
# Left empty on purpose: there is no such endpoint until 017/018 build one, and
# a fabricated URL would produce a connection failure that looks like a TLS
# finding. A1 reports "not runnable yet" rather than a wrong answer.
HTTPS_MCP_URL="${HTTPS_MCP_URL:-}"

DRY=""
[ "${1:-}" = "--dry-run" ] && DRY="yes"

say() { printf '%s\n' "$*"; }
row() { printf '%s\t%s\t%s\n' "$1" "$2" "$3" >>"$OUT/results.tsv"; }

# --- Preconditions, checked before anything is spent --------------------------
#
# Gated the way run-007a.sh is: everything that can be known before starting is
# known first, because the expensive failure is a trial that runs, fails for an
# environmental reason, and gets recorded as a measurement.

fail=0
precondition() {
  if [ "$2" = "ok" ]; then
    say "  ok      $1"
  else
    say "  MISSING $1 — $2"
    fail=1
  fi
}

say "run-016 preconditions:"

if [ -f "$PROBE" ]; then precondition "probe at $PROBE" ok
else precondition "probe at $PROBE" "copy spikes/mcp/probe-server.mjs here"; fi

if command -v node >/dev/null 2>&1; then
  precondition "node $(node --version)" ok
else precondition "node" "not on PATH"; fi

if command -v claude >/dev/null 2>&1; then
  precondition "claude $(claude --version 2>/dev/null | head -1)" ok
else precondition "claude" "not on PATH — it is system-wide at /usr/local/bin/claude on rtdvps"; fi

# The login. Checked by reading, not by `test -e`: run-007b.sh checked
# `[ -e ~agent1/.claude.json ]` as office, could not traverse 0750 ~agent1, and
# `test -e` cannot tell permission-denied from absent — so it told a correctly
# provisioned host to redo a login already done. Run as agent1 this is a
# legitimate vantage point, and `cat` distinguishes the two.
if cat "$HOME/.claude.json" >/dev/null 2>&1; then
  precondition "login ($HOME/.claude.json readable)" ok
else
  precondition "login ($HOME/.claude.json)" "run \`claude\` once and /login as this account first"
fi

# Trust, read out of the account's own config. An untrusted project is one of
# the three documented ways a session is alive and useless.
if grep -q "$PROJECT" "$HOME/.claude.json" 2>/dev/null; then
  precondition "project $PROJECT present in .claude.json" ok
else
  precondition "project $PROJECT trusted" "not in .claude.json — provisioning pre-trusts it, or open it once by hand"
fi

[ -d "$PROJECT" ] || { precondition "$PROJECT exists" "absent"; }

if [ "$fail" -ne 0 ]; then
  say ""
  say "Preconditions failed. Nothing run, nothing spent."
  exit 1
fi

mkdir -p "$OUT"
: >"$OUT/results.tsv"
say ""

if [ -n "$DRY" ]; then
  say "--dry-run: preconditions pass. Re-run without --dry-run to measure."
  say "Phase A spends no tokens. Phase B needs one interactive session."
  exit 0
fi

# --- PHASE A1 — does the MCP client honour NODE_EXTRA_CA_CERTS? --------------

say "A1  NODE_EXTRA_CA_CERTS and the MCP client"
if [ -z "$HTTPS_MCP_URL" ]; then
  say "    SKIPPED — no https MCP endpoint exists yet (017/018 build the first one)."
  say "    Set HTTPS_MCP_URL to one on the office cert and re-run. Reported as"
  say "    not-runnable rather than guessed: a fabricated URL fails to connect"
  say "    for reasons that look exactly like a TLS finding."
  row A1 skipped "no https MCP endpoint yet; set HTTPS_MCP_URL"
else
  if ! cat "$CERT" >/dev/null 2>&1; then
    row A1 inconclusive "cannot read $CERT as this account"
    say "    cannot read $CERT — on rtdvps it is 0600 office:office, so an"
    say "    agent account cannot read it. That is a provisioning question"
    say "    (009 exports the path into the agent's environment), not a TLS one."
  else
    say "    control: no NODE_EXTRA_CA_CERTS"
    claude mcp add-json "$SERVER_NAME-https" \
      "{\"type\":\"http\",\"url\":\"$HTTPS_MCP_URL\"}" --scope local >/dev/null 2>&1 || true
    unset NODE_EXTRA_CA_CERTS
    without=$(cd "$PROJECT" && claude mcp list 2>&1 | grep -F "$SERVER_NAME-https" || true)
    say "      $without"

    say "    treatment: NODE_EXTRA_CA_CERTS=$CERT"
    with=$(cd "$PROJECT" && NODE_EXTRA_CA_CERTS="$CERT" claude mcp list 2>&1 | grep -F "$SERVER_NAME-https" || true)
    say "      $with"

    claude mcp remove "$SERVER_NAME-https" --scope local >/dev/null 2>&1 || true

    case "$without$with" in
      *Connected*) row A1 measured "without=[$without] with=[$with]" ;;
      *)           row A1 inconclusive "neither run connected: without=[$without] with=[$with]" ;;
    esac
  fi
fi
say ""

# --- PHASE A2 — what is in an MCP server's environment? ----------------------
#
# `claude mcp list` health-checks approved servers, and health-checking a stdio
# server means SPAWNING it. So the probe's log captures the environment Claude
# Code gave it — no session, no tokens.
#
# MEASURED on the dev host 2026-10-10 and worth knowing before this runs:
# `--mcp-config` does NOT reach the `mcp list` subcommand. Passed after it,
# `mcp list` errors with "unknown option --mcp-config"; passed BEFORE it, the
# flag is SILENTLY IGNORED and only persisted servers are checked. Another flag
# that looks accepted and does nothing. Hence add-json/remove below rather than
# a config file.
#
# add-json writes to this account's own config at --scope local. Acceptable
# because this is a purpose-created throwaway agent account, and the server is
# removed again below. Do NOT run this as a human teammate's login.

say "A2  the environment an MCP server is spawned with"
PROBE_LOG="$OUT/probe-a2.log"
rm -f "$PROBE_LOG"

# OFFICE_SESSION_TOKEN is deliberately left UNSET in the parent environment
# while the config references ${OFFICE_SESSION_TOKEN}. That reproduces §3.3:
# the server should still load, with the literal placeholder as its value.
unset OFFICE_SESSION_TOKEN 2>/dev/null || true

claude mcp add-json "$SERVER_NAME" "$(cat <<JSON
{"command":"node","args":["$PROBE"],"env":{"MCP_PROBE_LOG":"$PROBE_LOG","OFFICE_SESSION_TOKEN":"\${OFFICE_SESSION_TOKEN}","OFFICE_SESSION_ID":"set-by-the-parent"}}
JSON
)" --scope local >/dev/null 2>&1 || {
  row A2 failed "claude mcp add-json refused the server config"
  say "    add-json refused. Nothing measured."
}

say "    claude mcp list (health check spawns stdio servers):"
(cd "$PROJECT" && claude mcp list 2>&1 | sed 's/^/      /') || true

claude mcp remove "$SERVER_NAME" --scope local >/dev/null 2>&1 || true

if [ -s "$PROBE_LOG" ]; then
  say "    probe was spawned; its log is at $PROBE_LOG"
  # The initialize frame is where the client describes itself.
  grep -F '"method":"initialize"' "$PROBE_LOG" | head -1 >"$OUT/a2-initialize.json" || true
  if grep -q "CLAUDE_CODE_SESSION_ID" "$PROBE_LOG"; then
    row A2 measured "CLAUDE_CODE_SESSION_ID IS present in the MCP server environment"
    say "    FINDING: CLAUDE_CODE_SESSION_ID is set. GLU-55 shrinks — see §3.4."
  else
    row A2 measured "CLAUDE_CODE_SESSION_ID is NOT present; only documented CLAUDE_PROJECT_DIR"
    say "    CLAUDE_CODE_SESSION_ID absent. The office must mint its own token (GLU-55)."
  fi
  if grep -q 'unexpandedVariables' "$PROBE_LOG"; then
    say "    (the \${...} placeholder check also recorded — see the log)"
  fi
else
  # A health check that does not spawn the server is itself the answer: it
  # means A2 needs a real session after all. Reported, not retried blindly.
  row A2 not_observed "probe never spawned — mcp list did not start the stdio server"
  say "    probe was NOT spawned, so a health check does not start stdio servers"
  say "    on this build. A2 moves into Phase B."
fi
say ""

# --- PHASE B — the two that need a session -----------------------------------

say "B   the two measurements that need one interactive session"
say ""
say "    NOT automated here on purpose: driving a live TUI is ticket 007's"
say "    machinery (spikes/tmux/drive-session.sh). Two drivers to keep correct"
say "    is worse than one plus a checklist."
say ""
say "    Attach the probe to a scratch role file, then start ONE session and"
say "    make all four calls in it — a login is single-session on this account,"
say "    so batch everything rather than spending it twice."
say ""
say "    1. Write ~/.claude/agents/probe-lead.md:"
say ""
say "         ---"
say "         name: probe-lead"
say "         description: Spike 016 probe desk."
say "         permissionMode: manual"
say "         mcpServers:"
say "           - office-probe:"
say "               type: stdio"
say "               command: node"
say "               args: [\"$PROBE\"]"
say "               env:"
say "                 MCP_PROBE_LOG: $OUT/probe-b.log"
say "         ---"
say ""
say "         You are a probe desk. Call the office-probe tools when asked."
say ""
say "    2. cd $PROJECT && claude --agent probe-lead --permission-mode manual"
say ""
say "    3. In the session, ask for each in turn:"
say "         call whoami with claimed_session_id \"i-am-lying\""
say "         call fail_soft"
say "         call fail_hard"
say ""
say "    B1 — did the error TEXT reach the model? Grep the AGENT TRANSCRIPT,"
say "         not the pane: the pane renders markdown and made backticks look"
say "         mangled once, and spike 002's harness reported all 36 trials as"
say "         failures because it resolved the caller's \$HOME instead of the"
say "         agent's. Transcripts are at ~/.claude/projects/<slug>/*.jsonl (0600):"
say ""
say "           grep -l OFFICE_PROBE_SOFT_ERROR \$HOME/.claude/projects/*/*.jsonl"
say "           grep -l OFFICE_PROBE_HARD_ERROR \$HOME/.claude/projects/*/*.jsonl"
say ""
say "         The measurement is not only whether the string appears — it is"
say "         whether the agent ACTED on the reason. A refusal that teaches is"
say "         the point; 017's claim_task refusals depend on it."
say ""
say "    B2 — did calling a tool raise a permission prompt? With an empty"
say "         allowlist it should. Then add to the session's settings:"
say "           {\"permissions\":{\"allow\":[\"mcp__office_probe__*\"]}}"
say "         and confirm the prompt stops. Then try \"mcp__*\" INSTEAD and"
say "         confirm it does NOT (an unanchored allow glob is skipped with a"
say "         warning — the trap in §6). Check \`claude doctor\` for the warning."
say ""
say "    4. Record what you saw in docs/spikes/003-mcp-wiring.md §8, and tick"
say "       016's criteria 4 and 5 only for what was actually observed."
say ""

say "results: $OUT/results.tsv"
cat "$OUT/results.tsv" 2>/dev/null || true
