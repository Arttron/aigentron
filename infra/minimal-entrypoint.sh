#!/usr/bin/env sh
# ----------------------------------------------------------------------
# Entrypoint for the minimal/single-container profile (docs/plan-single-
# container.md Phase 4). Applies pending sqlite migrations against the data
# dir, then execs the orchestrator (which also serves the dashboard SPA
# same-origin — one process, no supervisor needed). Shared verbatim by the
# Docker image (infra/minimal.Dockerfile — APP_DIR/DATA_DIR unset → defaults
# below) AND the bare-metal installer (install-bare.sh sets APP_DIR/DATA_DIR
# to real paths) — no forked/duplicated entrypoint logic between the two.
# ----------------------------------------------------------------------
set -e

APP_DIR="${APP_DIR:-/app}"
DATA_DIR="${DATA_DIR:-/data}"

mkdir -p "$DATA_DIR/agent" "$DATA_DIR/repo" "$DATA_DIR/worktrees" "$(dirname "${DATABASE_URL#file:}")"

# The baked-in agent defs (agent/agents/*.md, skills) live at $APP_DIR/agent;
# AGENT_DIR points at the persisted $DATA_DIR/agent so user edits survive a
# container recreate / upgrade. Seed the defaults once — never overwrite on
# later boots, or an edited/removed default would keep reverting. (The admin-seeded
# marker also blocks a re-copy if the orchestrator's seed step ever failed mid-way.)
if [ ! -d "$DATA_DIR/agent/agents" ] && [ ! -f "$DATA_DIR/agent/.sync/admin-seeded" ]; then
  echo "[entrypoint] seeding default agent defs into $DATA_DIR/agent…"
  cp -r "$APP_DIR/agent/." "$DATA_DIR/agent/"
fi

# Safety net before migrating: a consistent snapshot of the SQLite db (backups/pre-<version>.db, last 3 kept), taken once
# per version (the bare-metal installer has already taken it before this service was restarted). A failed migration is
# rolled back to it, and the container then exits with a clear message instead of booting on a half-migrated db.
DB_FILE="${DATABASE_URL#file:}"
SNAP_VERSION="${APP_VERSION:-unknown}"
SNAP_TAKEN=
case "${DATABASE_URL:-}" in
  file:*)
    # shellcheck disable=SC1091
    . "$APP_DIR/infra/db-snapshot.sh"
    if [ -s "$DB_FILE" ] && [ ! -s "$DATA_DIR/backups/pre-$SNAP_VERSION.db" ]; then
      if (cd "$APP_DIR/apps/orchestrator" && snapshot_db "$DB_FILE" "$DATA_DIR/backups" "$SNAP_VERSION" .); then
        SNAP_TAKEN=1
        echo "[entrypoint] database snapshot: $DATA_DIR/backups/pre-$SNAP_VERSION.db"
      else
        echo "[entrypoint] WARNING: could not take a database snapshot — continuing without one" >&2
      fi
    fi ;;
  *) echo "[entrypoint] non-SQLite DATABASE_URL — no snapshot (back up Postgres with pg_dump)" ;;
esac

echo "[entrypoint] applying database migrations (sqlite)…"
cd "$APP_DIR/apps/orchestrator"
if ! node_modules/.bin/prisma migrate deploy --config prisma.sqlite.config.ts; then
  if [ -n "$SNAP_TAKEN" ] && restore_db "$DB_FILE" "$DATA_DIR/backups" "$SNAP_VERSION"; then
    echo "[entrypoint] ERROR: database migration FAILED — the database was restored from backups/pre-$SNAP_VERSION.db. Roll back to the previous version." >&2
  else
    echo "[entrypoint] ERROR: database migration FAILED and no snapshot was restored (see $DATA_DIR/backups)." >&2
  fi
  exit 1
fi
cd "$APP_DIR"

# S-01: agents on their own OS user. Re-applied on EVERY start (the data volume outlives image versions and a
# restore/backup leaves root-owned files behind): user, modes on secrets/db/.env, ownership of what agents write,
# and a self-check as that user. A failed self-check stops the start — the orchestrator would refuse every run anyway.
if [ -n "${AGENT_RUN_AS_UID:-}" ]; then
  echo "[entrypoint] agent isolation: AGENT_RUN_AS_UID=$AGENT_RUN_AS_UID — applying infra/harden.sh"
  DATA_DIR="$DATA_DIR" APP_DIR="$APP_DIR" sh "$APP_DIR/infra/harden.sh" || exit 1
fi

echo "[entrypoint] starting orchestrator (also serves the dashboard, same-origin)…"
exec node "$APP_DIR/apps/orchestrator/dist/main.js"
