#!/bin/sh
# run-007b.sh — ticket 007's re-measurement through the REAL path.
#
# Run as `office`, after provision-host.sh. Supersedes run-007a.sh: that one
# existed only because no root was available, so it ran as the invoking user
# with no sudo in the path — which is the exact caveat ticket 003's readings
# carry and 007 exists to remove. This covers BOTH criteria:
#
#   (a) bare-agent RSS idle + mid-turn, and the payload-size limit
#   (b) sudo-parity, and delivery/interrupt/session-end through `sudo -n -u`
#
# Order is deliberate: everything cheap and everything load-bearing runs
# before `all`, so a failure costs the trials it already paid for and no more.
# `all --trials 20` is opt-in behind --full for that reason.
#
# PRECONDITIONS, each failing loudly rather than producing a wrong number:
#   * /etc/sudoers.d/office installed, granting office -> $SPIKE_USER
#   * $SPIKE_PROJECT_DIR is a git repo owned by $SPIKE_USER, and ALREADY
#     TRUSTED by it — a fresh account trusts nothing, and the folder-trust
#     dialog leaves tmux reporting a live session with a blocked TUI.
#     Spike 002 §4: Enter does not clear it. Clear it once, interactively.
#
# WHAT THIS SCRIPT CANNOT CHECK, AND WHY THAT IS CORRECT.
#
# Whether $SPIKE_USER has a Claude login is NOT verifiable from here. `office`
# cannot read ~$SPIKE_USER — that isolation is the whole reason each agent has
# its own account, and the sudoers grant deliberately permits /usr/bin/tmux and
# nothing else.
#
# The first version of this script tested `[ -e ~agent1/.claude.json ]` as
# office, got permission-denied, and reported it as "absent" — `test -e` cannot
# distinguish the two. It told a correctly provisioned host, with a login
# already done and folder trust already accepted, to go and do them again.
# Measured 2026-10-07 on rtdvps. Same shape as the `drive-session.sh` probe
# that tested a WIDER permission than the one granted: a check that asks for
# access the boundary is supposed to refuse reports a correct config as broken.
#
# So verify those from root, before handing over — the commands are printed
# below — and rely on the harness, which reports `auth_failed` per row rather
# than inventing a measurement.
set -eu

OUT="${OUT:-$HOME/007-vps}"
FULL=""; DRY=""
for a in "$@"; do
  [ "$a" = "--full" ] && FULL=1
  [ "$a" = "--dry-run" ] && DRY="--dry-run"
done

HARNESS="${HARNESS:-$HOME/drive-session.sh}"
[ -f "$HARNESS" ] || { echo "harness not found at $HARNESS" >&2; exit 1; }

export SPIKE_USER="${SPIKE_USER:-agent1}"
export SPIKE_TMUX="${SPIKE_TMUX:-/usr/bin/tmux}"
export SPIKE_CLAUDE="${SPIKE_CLAUDE:-/usr/local/bin/claude}"
export SPIKE_CLAUDE_ARGS="${SPIKE_CLAUDE_ARGS:---model sonnet}"
export SPIKE_TMPDIR="${SPIKE_TMPDIR:-/srv/office/spike003}"
export SPIKE_PROJECT_DIR="${SPIKE_PROJECT_DIR:-/srv/office/projects/throwaway}"
# SPIKE_CONFIG_DIR unset on purpose: $HOME selects agent1's login (GLU-44).

fail=0
note() { echo "  $*" >&2; }

echo "== preconditions" >&2
if [ "$(id -un)" = "root" ]; then
  note "FAIL running as root. The adapter refuses uid 0 and so does this."; fail=1
fi
if ! sudo -n -u "$SPIKE_USER" "$SPIKE_TMUX" -V >/dev/null 2>&1; then
  note "FAIL sudo -n -u $SPIKE_USER $SPIKE_TMUX is refused."
  note "     run provision-host.sh as root, and check TMUX_BIN matches the"
  note "     sudoers path byte for byte ($SPIKE_TMUX)."; fail=1
else
  note "ok   sudo -n -u $SPIKE_USER $SPIKE_TMUX -> $(sudo -n -u "$SPIKE_USER" "$SPIKE_TMUX" -V)"
fi
AGENT_HOME="$(getent passwd "$SPIKE_USER" 2>/dev/null | cut -d: -f6)"
[ -n "$AGENT_HOME" ] || { note "FAIL $SPIKE_USER does not exist"; fail=1; }

# NOT CHECKED HERE, deliberately — see the header. office cannot read
# ~$SPIKE_USER, and asking would report a correct host as broken.
note "n/a  $SPIKE_USER's Claude login and folder trust are UNVERIFIABLE from"
note "     \`office\` by design. Confirm as root, once:"
note "       stat -c '%a %U %s' $AGENT_HOME/.claude/.credentials.json"
note "       grep -c '$SPIKE_PROJECT_DIR' $AGENT_HOME/.claude.json   # >=1 = trusted"
note "     If either is missing every row below comes back auth_failed or"
note "     not_ready, which the harness reports distinctly — no fake numbers."

[ -d "$SPIKE_PROJECT_DIR/.git" ] || { note "FAIL $SPIKE_PROJECT_DIR is not a git repo"; fail=1; }

# The agent's user writes here (the SessionEnd hook runs as them), so this must
# be world-writable or theirs. Read the mode — do NOT try `sudo -u agent1 test`,
# which the sudoers file correctly refuses, making the check always warn.
[ -d "$SPIKE_TMPDIR" ] || mkdir -p "$SPIKE_TMPDIR" 2>/dev/null || true
if [ ! -d "$SPIKE_TMPDIR" ]; then
  note "FAIL $SPIKE_TMPDIR does not exist and could not be created"; fail=1
else
  t_mode="$(stat -c %a "$SPIKE_TMPDIR" 2>/dev/null || echo '')"
  t_owner="$(stat -c %U "$SPIKE_TMPDIR" 2>/dev/null || echo '')"
  case "$t_mode" in
    *7|*6|*3|*2) note "ok   $SPIKE_TMPDIR is $t_mode $t_owner — world-writable" ;;
    *) if [ "$t_owner" = "$SPIKE_USER" ]; then
         note "ok   $SPIKE_TMPDIR is $t_mode, owned by $SPIKE_USER"
       else
         note "FAIL $SPIKE_TMPDIR is $t_mode $t_owner — $SPIKE_USER cannot write it."
         note "     as root: install -d -m 0777 $SPIKE_TMPDIR"
         note "     The SessionEnd hook runs as $SPIKE_USER; without this the"
         note "     session-end rows come back empty and look like a missed hook."; fail=1
       fi ;;
  esac
fi
[ "$fail" -eq 0 ] || { echo >&2; echo "preconditions failed; nothing run, nothing spent." >&2; exit 2; }

mkdir -p "$OUT"
run() {
  name="$1"; shift
  echo "== $name" >&2
  # shellcheck disable=SC2086
  sh "$HARNESS" "$@" $DRY > "$OUT/$name.tsv" 2> "$OUT/$name.log" || \
    note "$name exited nonzero — see $OUT/$name.log"
  note "-> $OUT/$name.tsv ($(wc -l < "$OUT/$name.tsv") lines)"
}

echo "output: $OUT${DRY:+   (DRY RUN — launches nothing, spends nothing)}" >&2
run doctor       doctor
run sudo-parity  sudo-parity
run rss-idle     rss --samples 20 --interval 1
run rss-midturn  rss --samples 20 --interval 1 --midturn
run chars-echo   chars --mode echo
if [ -n "$FULL" ]; then
  run all        all --trials 20
else
  echo "== skipping \`all --trials 20\` (pass --full). The five above are the" >&2
  echo "   ones 007 cannot close without; \`all\` re-measures what WSL already" >&2
  echo "   gave provisionally." >&2
fi

echo >&2
echo "collect with:  scp -r office@100.109.232.2:$OUT ." >&2
