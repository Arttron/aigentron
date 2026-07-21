#!/usr/bin/env sh
# ----------------------------------------------------------------------
# Entrypoint for the minimal/single-container image (docs/plan-single-
# container.md Phase 4). Applies pending sqlite migrations against the
# mounted /data volume, then hands off to the process supervisor.
# ----------------------------------------------------------------------
set -e

mkdir -p /data/agent /data/repo /data/worktrees "$(dirname "${DATABASE_URL#file:}")"

# The baked-in agent defs (agent/agents/*.md, skills) live in the image at
# /app/agent; AGENT_DIR points at the persisted /data/agent so user edits
# survive a container recreate. Seed the defaults into the volume once — never
# overwrite on later boots, or an edited/removed default would keep reverting.
if [ ! -d /data/agent/agents ]; then
  echo "[entrypoint] seeding default agent defs into /data/agent…"
  cp -r /app/agent/. /data/agent/
fi

echo "[entrypoint] applying database migrations (sqlite)…"
cd /app/apps/orchestrator
node_modules/.bin/prisma migrate deploy --config prisma.sqlite.config.ts
cd /app

echo "[entrypoint] starting supervisor…"
exec node /app/infra/minimal-supervisor.mjs
