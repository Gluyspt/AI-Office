#!/bin/sh
# Provision one Linux account to run AI Agent Office agent sessions.
#
# Ticket 009. The OS-level half — creating the accounts, the scoped sudo
# grant, the TLS material — is deploy/host/provision-host.sh and runs once
# per host. This runs once per *account*, and installs what turns a bare
# agent into an office desk:
#
#   * the office hook entries, merged from config/hooks/base.settings.json
#     plus every fragment in config/hooks/fragments/
#   * the role definitions, where `claude --agent <role>` finds them
#   * the project paths, pre-trusted in that account's own .claude.json
#   * a git identity, because an account with none cannot commit at all
#
# DELIBERATELY A THIN WRAPPER. Every decision and every refusal lives in
# packages/server/src/features/orchestrator/provision.ts, which has its own
# CLI — so the logic the unit tests exercise is the same logic that runs on
# the box, rather than existing twice and drifting. This file adds only the
# three checks a shell can make better than Node can, and then gets out of
# the way.
#
# Idempotent, like provision-host.sh: re-running produces byte-identical
# output and duplicates no hook entry. Re-running after a partial failure is
# safe and is the intended way to use it.
#
#
# USAGE  (every argument is passed through to provision.ts's own CLI)
#   scripts/provision-user.sh --user agent1 --project /srv/office/projects/schedool
#
#   --user NAME          required
#   --home DIR           default /home/NAME
#   --project DIR        a directory to pre-trust. Repeatable.
#   --roles a,b          default: every role this ticket ships
#   --format text|sh     `sh` emits shell assignments for a caller to eval
#   --uid N / --gid N    ownership for files written as root
#   --allow-no-login     provision an account nobody has logged in as. Warns.
#
# provision.ts has no --help of its own; the block above is the reference.
#
# Configuration comes from .env — OFFICE_HOOK_TOKENS, AGENT_CA_CERT_PATH,
# AGENT_EVENT_SERVER_ORIGIN, AGENT_GIT_EMAIL_DOMAIN — not from flags, so the
# values the server reads and the values provisioning writes cannot disagree.
#
#
# TWO THINGS WORTH KNOWING BEFORE YOU RUN IT
#
# It refuses an account that has never logged in. A missing ~/.claude.json
# means nobody has run `claude` as that account; provisioning cannot fix that
# (/login is a browser flow), and a desk spawned on such an account reaches
# the onboarding screen instead of the composer — one of three ways ticket
# 007 catalogued a session reporting itself alive while being useless.
# Failing here with the sequence spelled out beats failing at spawn time with
# an empty pane. --allow-no-login exists for the VPS simulator and CI.
#
# Without at least one --project, nothing is pre-trusted and the first spawn
# parks on the folder-trust dialog. Spike 002 §4: Enter does not dismiss it.
# provision.ts warns; it does not refuse, because a host simulation has no
# projects.
set -eu

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SELF_DIR/.." && pwd)"
MODULE="$REPO_ROOT/packages/server/src/features/orchestrator/provision.ts"

die() { echo "provision-user.sh: $*" >&2; exit 1; }

[ -f "$MODULE" ] || die "cannot find $MODULE"
command -v node >/dev/null 2>&1 || die "node is not on PATH"

# --- The three checks a shell makes better than Node does -----------------------

# 1. Which account, read from the same argv Node will parse. Done here only
#    so checks 2 and 3 can run before Node starts and fail with a clearer
#    message than a stack trace.
USER_NAME=""
PREV=""
for ARG in "$@"; do
  [ "$PREV" = "--user" ] && { USER_NAME="$ARG"; break; }
  PREV="$ARG"
done
[ -n "$USER_NAME" ] || die "--user is required — see the usage block at the top of this file"

# 2. The account must already exist. This script provisions a login's
#    configuration; it does not create accounts. Keeping that split means
#    neither script half-does the other's job.
id "$USER_NAME" >/dev/null 2>&1 \
  || die "no such user: $USER_NAME — deploy/host/provision-host.sh creates the agent accounts"

# 3. Refuse to write as a third user. Files would land owned by someone the
#    agent is not, and the symptom — an agent that cannot read its own hook
#    config — looks like a provisioning bug rather than a permissions one.
ME="$(id -un)"
if [ "$ME" != "root" ] && [ "$ME" != "$USER_NAME" ]; then
  die "run this as root or as $USER_NAME, not as $ME — anything written would be owned by the wrong account"
fi

# As root, hand Node the target's uid/gid so what it writes ends up owned by
# the agent rather than by root. Passed as flags rather than discovered
# inside provision.ts, because `id` is the shell's job and this keeps the
# module free of platform lookups.
OWNERSHIP=""
if [ "$ME" = "root" ]; then
  OWNERSHIP="--uid $(id -u "$USER_NAME") --gid $(id -g "$USER_NAME")"
fi

# --- Hand over ------------------------------------------------------------------
# shellcheck disable=SC2086
exec node --experimental-strip-types "$MODULE" "$@" $OWNERSHIP
