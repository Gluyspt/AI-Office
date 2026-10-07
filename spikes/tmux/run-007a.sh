#!/bin/sh
# run-007a.sh — ticket 007 criterion (a), staged for rtdvps 2026-10-07.
#
# Takes the two measurements that need a Claude login and NOTHING ELSE:
# no root, no `office` account, no sudo in the path. Correct for both, because
# what the WSL pass got wrong was the kernel and memory accounting, not sudo.
#
#   * per-agent RSS, idle and mid-turn  -> ticket 007's floor, and the first
#     mid-turn reading taken on any host
#   * the payload-size limit            -> the figure ticket 007's code comment
#     asks for, unscrapeable from the pane (>=1000 chars renders [Pasted text #N])
#
# THESE TRIALS START REAL AGENTS AND SPEND REAL TOKENS. --dry-run first.
#
# Deliberately NOT measured here, and why:
#   * anything through `sudo -n -u`  — no office account on this host; criterion (b)
#   * loaded RSS (hooks, role file, MCP servers) — that is ticket 018's, because
#     hooks and role files are 009's output and 009 comes after 007. See 007's
#     Decided section on the cycle.
set -eu

OUT="${OUT:-$HOME/007-vps}"
DRY=""
[ "${1:-}" = "--dry-run" ] && DRY="--dry-run"

HARNESS="${HARNESS:-$HOME/drive-session.sh}"
[ -f "$HARNESS" ] || { echo "harness not found at $HARNESS" >&2; exit 1; }
chmod +x "$HARNESS" 2>/dev/null || true

# rtdvps specifics. The binary is a system-wide install; ticket 007 recorded it
# as per-account ~/.local/bin/claude, which does not exist here.
export SPIKE_CLAUDE="${SPIKE_CLAUDE:-/usr/local/bin/claude}"
export SPIKE_CLAUDE_ARGS="${SPIKE_CLAUDE_ARGS:---model sonnet}"
export SPIKE_TMPDIR="${SPIKE_TMPDIR:-$HOME/spike003-tmp}"
export SPIKE_PROJECT_DIR="${SPIKE_PROJECT_DIR:-$SPIKE_TMPDIR/proj}"
# SPIKE_USER unset on purpose: no sudo in the path, and neither measurement needs it.
# SPIKE_CONFIG_DIR unset on purpose: $HOME already selects this account's login (GLU-44).

[ -x "$SPIKE_CLAUDE" ] || { echo "no claude at $SPIKE_CLAUDE" >&2; exit 1; }

# A login is the whole precondition, so fail on it clearly rather than letting
# every row come back auth_failed.
if [ ! -f "$HOME/.claude.json" ]; then
  echo "NO CLAUDE LOGIN on this account ($(id -un))." >&2
  echo "  $SPIKE_CLAUDE   then /login, then re-run this script." >&2
  echo "  Nothing below can be measured without it." >&2
  exit 2
fi

mkdir -p "$OUT" "$SPIKE_PROJECT_DIR"
if [ ! -d "$SPIKE_PROJECT_DIR/.git" ]; then
  ( cd "$SPIKE_PROJECT_DIR" && git init -q && git commit -q --allow-empty -m "throwaway" 2>/dev/null ) || true
fi

run() {
  name="$1"; shift
  echo "== $name" >&2
  # shellcheck disable=SC2086
  sh "$HARNESS" "$@" $DRY > "$OUT/$name.tsv" 2> "$OUT/$name.log" || \
    echo "   $name exited nonzero — see $OUT/$name.log" >&2
  echo "   -> $OUT/$name.tsv ($(wc -l < "$OUT/$name.tsv") lines)" >&2
}

echo "output dir: $OUT${DRY:+   (DRY RUN — launches nothing, spends nothing)}" >&2
run doctor      doctor
run rss-idle    rss --samples 20 --interval 1
run rss-midturn rss --samples 20 --interval 1 --midturn
run chars-echo  chars --mode echo

echo >&2
echo "done. Collect with:" >&2
echo "  scp -r gluy@100.109.232.2:$OUT ." >&2
