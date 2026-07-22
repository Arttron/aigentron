#!/usr/bin/env sh
# ----------------------------------------------------------------------
# Entrypoint for the minimal/single-container profile (docs/plan-single-
# container.md Phase 4). Applies pending sqlite migrations against the data
# dir, then hands off to the process supervisor. Shared verbatim by the
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
# later boots, or an edited/removed default would keep reverting.
if [ ! -d "$DATA_DIR/agent/agents" ]; then
  echo "[entrypoint] seeding default agent defs into $DATA_DIR/agent…"
  cp -r "$APP_DIR/agent/." "$DATA_DIR/agent/"
fi

echo "[entrypoint] applying database migrations (sqlite)…"
cd "$APP_DIR/apps/orchestrator"
node_modules/.bin/prisma migrate deploy --config prisma.sqlite.config.ts
cd "$APP_DIR"

echo "[entrypoint] starting supervisor…"
exec node "$APP_DIR/infra/minimal-supervisor.mjs"
