#!/usr/bin/env bash
# Run the repo's own test suite on Linux, inside the provisioned host image.
#
# Why this exists: every test run until 2026-09-22 happened on Windows. The
# target is a Linux VPS, and "it passes on Windows" is not evidence about
# the machine this system will actually run on — path handling, file modes,
# TLS material read from a Unix path, and the tmux adapter's argv building
# all differ in ways a Windows run cannot exercise.
#
# It deliberately uses the image from deploy/vps-sim/Dockerfile, so the run
# happens on a host provisioned by deploy/host/provision-host.sh with that
# script's own TLS material — the certs are exercised end to end rather than
# assumed.
#
# The repo is mounted read-only and copied to a scratch directory first:
# node_modules on the host is built for Windows (native binaries, .cmd
# shims) and cannot be reused, and nothing in a check should be able to
# write to the working tree.
set -euo pipefail

SRC=${SRC:-/srv/office/orchestrator}
WORK=${WORK:-/tmp/linux-check}
DB_URL=${DB_URL:-postgresql://office:office@db:5432/office}
PNPM=${PNPM:-pnpm@12.5.1}

echo "== host"
uname -sr
echo "node $(node --version)"
echo "tmux $(tmux -V)"

echo
echo "== staging a writable copy of the tree"
rm -rf "$WORK"
mkdir -p "$WORK"
# .git is large and irrelevant; .devtls is the host's Windows-path cert pair,
# replaced below by the ones this image provisioned.
tar --exclude=node_modules --exclude=.git --exclude=.devtls -cf - -C "$SRC" . \
  | (cd "$WORK" && tar -xf -)
cd "$WORK"

cat > .env <<ENVEOF
DATABASE_URL=$DB_URL
EVENT_SERVER_PORT=4000
OFFICE_USER=office
PROJECT_ROOT=/srv/office/projects
TLS_CERT_PATH=/srv/office/tls/dev-cert.pem
TLS_KEY_PATH=/srv/office/tls/dev-key.pem
HOOK_INGEST_TOKENS=linux-check-token
TMUX_AGENT_USERS=gluy,user2,user3
TMUX_BIN=/usr/bin/tmux
SUDO_BIN=/usr/bin/sudo
# Ticket 008's hook-arrival gate. Required with no default, so the config
# path is exercised here even though the tests pass their own override.
SESSION_HOOK_ARRIVAL_TIMEOUT_MS=15000
# Ticket 028's resume path needs a binary to respawn with. Absolute: a bare
# `claude` dies instantly in tmux's non-interactive shell.
CLAUDE_BIN=/usr/local/bin/claude
# Ticket 009's provisioning. OFFICE_HOOK_TOKENS is the per-account map; it is
# cross-checked against HOOK_INGEST_TOKENS above, because if they disagree
# every hook 401s, every session fails 008's hook gate, and nothing in the
# failure names the mismatch.
# Ticket 015's lock TTL. The lock tests pass their own, but ticket 028's
# resume is the first code path that loads this from config rather than
# taking it as a parameter — so without it every resume throws ConfigError.
LOCK_TTL_SECONDS=900
OFFICE_HOOK_TOKENS=agent1:linux-check-token
AGENT_EVENT_SERVER_ORIGIN=https://127.0.0.1:4000
AGENT_CA_CERT_PATH=/srv/office/tls/dev-cert.pem
AGENT_GIT_EMAIL_DOMAIN=office.invalid
ENVEOF

echo
echo "== install"
npx --yes "$PNPM" install --silent >/dev/null 2>&1
echo "ok"

echo
echo "== typecheck"
npx --yes "$PNPM" typecheck

echo
echo "== migrate"
npx --yes "$PNPM" migrate

echo
echo "== test"
npx --yes "$PNPM" test
