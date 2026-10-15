#!/bin/sh
# ----------------------------------------------------------------------
# harden.sh — agent/orchestrator OS-user separation (S-01). Idempotent; run as
# root. Used by: the container entrypoint on every start (volumes outlive
# image versions), install.sh (fresh bare-metal installs) and `aigentron harden`.
#
#   AGENT_RUN_AS_UID / AGENT_RUN_AS_GID   the agent user (default 1500/1500)
#   DATA_DIR    (default /data)   secrets/, orchestrator.db, repo/, worktrees/, workspace/, agent/
#   APP_DIR     (default /app)    the release (hook script, shared dist, node_modules)
#   ENV_FILE    (optional)        the .env the service reads (bare-metal) → 0600
#
# What it does, and prints:
#   1. creates the `agent` user/group with that uid/gid if no such uid exists
#   2. closes what the agent must never read: secrets/ 0700, the SQLite db (+wal/shm)
#      0600, litellm-config.generated.yaml 0600, backups/ 0700, update/ 0700, .env 0600
#   3. hands the agent what it writes: repo/, worktrees/*, workspace/, agent/attachments/,
#      agent/runs/*/{home,codex-home} → chown -R agent
#   4. lets root's git work in agent-owned checkouts: safe.directory=* in the system gitconfig
#   5. self-check as the agent user through infra/agent-exec.sh (the very path the
#      orchestrator uses): secrets unreadable, the hook/shared dist/node readable
# ----------------------------------------------------------------------
set -u

UID_="${AGENT_RUN_AS_UID:-1500}"
GID_="${AGENT_RUN_AS_GID:-$UID_}"
DATA_DIR="${DATA_DIR:-/data}"
APP_DIR="${APP_DIR:-/app}"
ENV_FILE="${ENV_FILE:-}"
AGENT_DIR="${AGENT_DIR:-$DATA_DIR/agent}"
REPO_DIR="${WORKSPACE_REPO_PATH:-$DATA_DIR/repo}"
WORKTREES_DIR="${WORKTREES_ROOT:-$DATA_DIR/worktrees}"
ATTACH_DIR="${ATTACHMENTS_DIR:-$AGENT_DIR/attachments}"
WORKSPACE_DIR="${WORKSPACE_DIR:-$DATA_DIR/workspace}"
SECRETS_DIR="${SECRETS_DIR:-$DATA_DIR/secrets}"
DB_FILE="${DATABASE_URL#file:}"; case "${DATABASE_URL:-}" in file:*) ;; *) DB_FILE="$DATA_DIR/orchestrator.db" ;; esac

say() { echo "[harden] $1"; }
die() { echo "[harden] ERROR: $1" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "must run as root"
case "$UID_$GID_" in *[!0-9]*) die "AGENT_RUN_AS_UID/GID must be numeric (got $UID_/$GID_)" ;; esac
[ "$UID_" != 0 ] && [ "$GID_" != 0 ] || die "AGENT_RUN_AS_UID/GID must not be 0 (the agent must not be root)"
command -v setpriv >/dev/null 2>&1 || die "setpriv (package util-linux) is required to run agents as another user"

# 1. the user
if ! getent group "$GID_" >/dev/null 2>&1; then
  if command -v groupadd >/dev/null 2>&1; then groupadd -g "$GID_" agent; else addgroup -g "$GID_" agent; fi
  say "created group agent (gid $GID_)"
fi
if ! getent passwd "$UID_" >/dev/null 2>&1; then
  if command -v useradd >/dev/null 2>&1; then
    useradd -r -u "$UID_" -g "$GID_" -d /nonexistent -s /usr/sbin/nologin -M agent
  else
    adduser -D -H -u "$UID_" -G "$(getent group "$GID_" | cut -d: -f1)" -h /nonexistent -s /sbin/nologin agent
  fi
  say "created user agent (uid $UID_)"
fi
AGENT_NAME=$(getent passwd "$UID_" | cut -d: -f1)

# 2. what the agent must never read
mkdir -p "$SECRETS_DIR" "$DATA_DIR/backups"
chmod 700 "$SECRETS_DIR" "$DATA_DIR/backups"
[ -d "$DATA_DIR/update" ] && chmod 700 "$DATA_DIR/update"
for f in "$DB_FILE" "$DB_FILE-wal" "$DB_FILE-shm" "$DB_FILE-journal" "$DATA_DIR/litellm-config.generated.yaml" "$ENV_FILE"; do
  [ -n "$f" ] && [ -f "$f" ] && { chown 0:0 "$f"; chmod 600 "$f"; }
done
# the per-run Codex homes of other tasks and the admin audit stay out of the agent's reach where they are root-owned;
# the secrets dir holds the shared Codex sign-in (0700 above). Nothing else in the data dir is secret.
say "closed: $SECRETS_DIR (0700), $DB_FILE (0600), $DATA_DIR/backups (0700)${ENV_FILE:+, $ENV_FILE (0600)}"

# 3. what the agent writes (the orchestrator re-applies this per run for the task's own dirs; this is the one-time/boot pass)
mkdir -p "$REPO_DIR" "$WORKTREES_DIR" "$WORKSPACE_DIR" "$ATTACH_DIR" "$AGENT_DIR/runs"
chmod 755 "$DATA_DIR" "$AGENT_DIR" "$AGENT_DIR/runs" "$WORKTREES_DIR" 2>/dev/null || true
chown -R "$UID_:$GID_" "$REPO_DIR" "$WORKSPACE_DIR" "$ATTACH_DIR"
for d in "$WORKTREES_DIR"/*/ "$AGENT_DIR"/runs/*/home/ "$AGENT_DIR"/runs/*/codex-home/; do
  [ -d "$d" ] && chown -R "$UID_:$GID_" "$d"
done
say "owned by $AGENT_NAME: $REPO_DIR, $WORKSPACE_DIR, $ATTACH_DIR, $WORKTREES_DIR/*, $AGENT_DIR/runs/*/{home,codex-home}"

# 4. root's git in agent-owned checkouts
if command -v git >/dev/null 2>&1; then
  if ! git config --system --get-all safe.directory 2>/dev/null | grep -qx '\*'; then
    git config --system --add safe.directory '*' && say "git: safe.directory=* added to the system gitconfig"
  fi
fi

# 5. self-check through the same wrapper the orchestrator uses
WRAPPER="$APP_DIR/infra/agent-exec.sh"
[ -x "$WRAPPER" ] || chmod +x "$WRAPPER" 2>/dev/null || die "wrapper $WRAPPER is missing — agents cannot run as $AGENT_NAME"
as_agent() { exe="$1"; shift; LDS_AGENT_EXEC="$exe" LDS_AGENT_UID="$UID_" LDS_AGENT_GID="$GID_" "$WRAPPER" "$@" 2>/dev/null; }
bad=0
if [ "$(as_agent id -u | tr -d ' ')" != "$UID_" ]; then say "SELF-CHECK FAILED: the wrapper did not switch to uid $UID_"; bad=1; fi
if as_agent test -r "$SECRETS_DIR"; then say "SELF-CHECK FAILED: $SECRETS_DIR is readable by $AGENT_NAME"; bad=1; fi
if [ -f "$DB_FILE" ] && as_agent test -r "$DB_FILE"; then say "SELF-CHECK FAILED: $DB_FILE is readable by $AGENT_NAME"; bad=1; fi
for f in "$APP_DIR/infra/hooks/pre-tool-use.mjs" "$APP_DIR/packages/shared/dist/index.js" "$(command -v node)"; do
  if ! as_agent test -r "$f"; then say "SELF-CHECK FAILED: $f is NOT readable by $AGENT_NAME (the release dir must be world-readable: chmod -R o+rX $APP_DIR)"; bad=1; fi
done
if ! as_agent test -w "$WORKSPACE_DIR"; then say "SELF-CHECK FAILED: $WORKSPACE_DIR is not writable by $AGENT_NAME"; bad=1; fi
if [ "$bad" = 0 ]; then
  say "self-check OK: agents run as $AGENT_NAME (uid $UID_, gid $GID_); secrets and the database are closed to them"
else
  die "self-check failed — agent runs will refuse to start until this is fixed (AGENT_RUN_AS_UID is set)"
fi
