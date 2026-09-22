#!/bin/sh
# Provision a Linux host to run AI Agent Office agent sessions.
#
# This is the host-setup step that no ticket in steps 1-3 owns. Spike 002
# says so outright (docs/spikes/002-tmux-tui-control.md): "Nothing in the
# 32-ticket set provisions the host, creates the `office` account or the
# agent users, or installs the sudoers file as a host-setup step."
#
# It runs in two places and must behave identically in both:
#
#   * inside deploy/Dockerfile.vps-sim, so the steps are exercised on every
#     image build rather than improvised once on a rented box
#   * on the real VPS, as root
#
# Idempotent by construction: every step checks for its own result first, so
# re-running after a partial failure is safe and is the intended way to use
# it.
#
# What it does NOT do: log any agent in, install Claude Code's per-user hook
# config, or write role definitions. Those are ticket 009 (scripts/provision-
# user.sh) and are deliberately a different job from OS-level provisioning.
set -eu

OFFICE_USER="${OFFICE_USER:-office}"
TMUX_AGENT_USERS="${TMUX_AGENT_USERS:-gluy,user2,user3}"
PROJECT_ROOT="${PROJECT_ROOT:-/srv/office/projects}"
TLS_DIR="${TLS_DIR:-/srv/office/tls}"
TMUX_BIN="${TMUX_BIN:-/usr/bin/tmux}"

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
SUDOERS_SRC="${SUDOERS_SRC:-$SELF_DIR/sudoers.d/office}"
SUDOERS_DST=/etc/sudoers.d/office

FAILED=0

say()  { printf '  %s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
ok()   { printf '  ok      %s\n' "$*"; }
warn() { printf '  WARN    %s\n' "$*"; }
bad()  { printf '  FAILED  %s\n' "$*"; FAILED=$((FAILED + 1)); }

agent_users() { printf '%s' "$TMUX_AGENT_USERS" | tr ',' ' '; }

[ "$(id -u)" -eq 0 ] || { echo "provision-host.sh must run as root" >&2; exit 1; }

# ---------------------------------------------------------------------------
step "Packages"
# Only what the orchestrator and the spike harness actually need. procps is
# for ps (the harness reads RSS from it); openssl for the dev cert. The
# millisecond clock the harness needs (date +%s%3N) is GNU coreutils, which
# is already present on any Debian/Ubuntu host.
NEEDED=""
for pair in "tmux:tmux" "sudo:sudo" "ps:procps" "openssl:openssl" "git:git"; do
  bin="${pair%%:*}"
  pkg="${pair##*:}"
  command -v "$bin" >/dev/null 2>&1 || NEEDED="$NEEDED $pkg"
done
if [ -n "$NEEDED" ]; then
  if command -v apt-get >/dev/null 2>&1; then
    say "installing:$NEEDED"
    DEBIAN_FRONTEND=noninteractive apt-get update -qq
    # shellcheck disable=SC2086
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends $NEEDED >/dev/null
    ok "installed$NEEDED"
  else
    bad "missing packages:$NEEDED and no apt-get to install them"
  fi
else
  ok "tmux, sudo, ps, openssl, git all present"
fi

# The sudoers rule grants a literal path. If tmux is not at exactly that
# path, every spawn fails with a permission error that looks like a broken
# rule rather than a path mismatch. Catch it here instead.
if [ -x "$TMUX_BIN" ]; then
  ok "$TMUX_BIN exists ($("$TMUX_BIN" -V 2>/dev/null || echo 'version unknown'))"
else
  WHERE="$(command -v tmux 2>/dev/null || echo 'not found')"
  bad "TMUX_BIN=$TMUX_BIN does not exist; tmux is at: $WHERE"
  say "sudo matches the permitted command as a literal path -- /usr/bin/tmux"
  say "and /bin/tmux are different grants even if one symlinks to the other."
  say "Fix deploy/sudoers.d/office and TMUX_BIN in .env together, or symlink."
fi

# ---------------------------------------------------------------------------
step "Accounts"
# The orchestrator account. Unprivileged: it gains exactly one thing, the
# scoped tmux grant below, and the adapter refuses to start if its uid is 0.
if id -u "$OFFICE_USER" >/dev/null 2>&1; then
  ok "$OFFICE_USER exists (uid $(id -u "$OFFICE_USER"))"
else
  useradd --create-home --shell /bin/bash "$OFFICE_USER"
  ok "created $OFFICE_USER (uid $(id -u "$OFFICE_USER"))"
fi

# The agent accounts. One Linux user per team member: this is what makes
# each agent's $HOME, and therefore its Claude login, separate.
for u in $(agent_users); do
  if id -u "$u" >/dev/null 2>&1; then
    ok "$u exists (uid $(id -u "$u"))"
  else
    useradd --create-home --shell /bin/bash "$u"
    ok "created $u (uid $(id -u "$u"))"
  fi
done

# ---------------------------------------------------------------------------
step "Scoped sudoers"
# visudo -c -f BEFORE install is not ceremony. /etc/sudoers.d is parsed as
# part of the whole sudoers set, so a syntax error here can lock every user
# out of sudo on the host.
if [ ! -f "$SUDOERS_SRC" ]; then
  bad "sudoers source not found at $SUDOERS_SRC"
else
  if visudo -c -f "$SUDOERS_SRC" >/dev/null 2>&1; then
    ok "visudo -c -f passes on $SUDOERS_SRC"
    # 0440 root:root -- sudo silently ignores a file in sudoers.d that is
    # group- or world-writable, and the symptom is "the rule does nothing".
    install -o root -g root -m 0440 "$SUDOERS_SRC" "$SUDOERS_DST"
    ok "installed $SUDOERS_DST (0440 root:root)"
    if visudo -c >/dev/null 2>&1; then
      ok "visudo -c passes on the whole sudoers set"
    else
      bad "visudo -c FAILS on the whole set after install -- removing $SUDOERS_DST"
      rm -f "$SUDOERS_DST"
    fi
  else
    bad "visudo -c -f rejects $SUDOERS_SRC -- not installed"
    visudo -c -f "$SUDOERS_SRC" 2>&1 | sed 's/^/    /'
  fi
fi

# The sudoers file and TMUX_AGENT_USERS in .env are two separate lists on
# purpose: sudo is the kernel-side boundary, the env allowlist is the
# application-side one. They must agree, or a spawn is refused by whichever
# is narrower and the error names the wrong layer.
if [ -f "$SUDOERS_DST" ]; then
  for u in $(agent_users); do
    if grep -qE "^[[:space:]]*$OFFICE_USER[[:space:]]+ALL=\($u\)" "$SUDOERS_DST"; then
      ok "sudoers grants $OFFICE_USER -> $u"
    else
      bad "TMUX_AGENT_USERS lists '$u' but sudoers has no rule for it"
    fi
  done
fi

# ---------------------------------------------------------------------------
step "Directories and TLS"
for d in "$PROJECT_ROOT" "$TLS_DIR"; do
  [ -d "$d" ] || mkdir -p "$d"
done
chown "$OFFICE_USER:$OFFICE_USER" "$PROJECT_ROOT" "$TLS_DIR"
ok "$PROJECT_ROOT and $TLS_DIR exist, owned by $OFFICE_USER"

# .env.example ships TLS_CERT_PATH/TLS_KEY_PATH pointing here, and nothing
# in the repo generates them -- copying .env.example verbatim gives a pile
# of confusing failures. Generate a self-signed pair if none exists.
#
# Note what spike 001 found (docs/spikes/001-hook-payloads.md, section 12):
# Claude Code's hook client REFUSES a self-signed cert. The handshake is
# rejected and no event arrives, which is indistinguishable from a hook that
# never fired. NODE_EXTRA_CA_CERTS pointed at this cert is the fix, and it
# has to be in the environment of every agent session -- tickets 007, 009.
CERT="$TLS_DIR/dev-cert.pem"
KEY="$TLS_DIR/dev-key.pem"
if [ -f "$CERT" ] && [ -f "$KEY" ]; then
  ok "dev cert already present at $CERT"
elif command -v openssl >/dev/null 2>&1; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
    -keyout "$KEY" -out "$CERT" -subj "/CN=localhost" \
    -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" >/dev/null 2>&1
  chown "$OFFICE_USER:$OFFICE_USER" "$CERT" "$KEY"
  chmod 0600 "$KEY"
  chmod 0644 "$CERT"
  ok "generated self-signed dev cert -> $CERT"
  say "agents need NODE_EXTRA_CA_CERTS=$CERT or every hook fails silently"
else
  warn "openssl missing -- no dev cert generated"
fi

# ---------------------------------------------------------------------------
step "Verification (this is the acceptance check, not the install)"
# Everything above can succeed and the grant still not work. Prove it by
# exercising the real path: as the office user, non-interactively, to each
# agent account, on the exact binary the sudoers rule names.
for u in $(agent_users); do
  if su -s /bin/sh -c "sudo -n -u $u $TMUX_BIN -V" "$OFFICE_USER" >/dev/null 2>&1; then
    ok "$OFFICE_USER can run '$TMUX_BIN -V' as $u, passwordless"
  else
    bad "$OFFICE_USER CANNOT sudo -n -u $u $TMUX_BIN"
    su -s /bin/sh -c "sudo -n -u $u $TMUX_BIN -V" "$OFFICE_USER" 2>&1 | sed 's/^/    /' || true
  fi
done

# The orchestrator must never be able to reach root through this grant.
if su -s /bin/sh -c "sudo -n -u root $TMUX_BIN -V" "$OFFICE_USER" >/dev/null 2>&1; then
  bad "$OFFICE_USER can run tmux as ROOT -- the grant is too wide"
else
  ok "$OFFICE_USER cannot run tmux as root"
fi

# And nothing beyond tmux.
FIRST_AGENT="$(agent_users | cut -d' ' -f1)"
if su -s /bin/sh -c "sudo -n -u $FIRST_AGENT /bin/sh -c true" "$OFFICE_USER" >/dev/null 2>&1; then
  bad "$OFFICE_USER can run an arbitrary shell as $FIRST_AGENT -- too wide"
else
  ok "$OFFICE_USER cannot run anything but $TMUX_BIN"
fi

printf '\n'
if [ "$FAILED" -eq 0 ]; then
  echo "provision-host.sh: all checks passed"
else
  echo "provision-host.sh: $FAILED check(s) FAILED"
  exit 1
fi
