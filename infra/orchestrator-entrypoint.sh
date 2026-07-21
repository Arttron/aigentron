#!/usr/bin/env sh
# ----------------------------------------------------------------------
# Dev entrypoint for the orchestrator container.
# Runs against the bind-mounted source tree, so Prisma client generation
# and migrations happen here (not at image build) to land in the mount.
# ----------------------------------------------------------------------
set -e

echo "[entrypoint] syncing dependencies (frozen lockfile)…"
pnpm install --frozen-lockfile --prefer-offline

# Storage driver by DATABASE_URL scheme (docs/plan-single-container.md Phase
# 2): `file:` = sqlite (minimal/single-container profile), else postgres
# (`full` profile — the default, unchanged behavior below).
case "$DATABASE_URL" in
  file:*)
    echo "[entrypoint] generating Prisma client (sqlite)…"
    pnpm --filter @lds/orchestrator exec prisma generate --schema=prisma/sqlite/schema.prisma
    echo "[entrypoint] applying database migrations (sqlite)…"
    pnpm --filter @lds/orchestrator exec prisma migrate deploy --config prisma.sqlite.config.ts
    ;;
  *)
    echo "[entrypoint] generating Prisma client…"
    pnpm --filter @lds/orchestrator exec prisma generate

    echo "[entrypoint] applying database migrations…"
    pnpm --filter @lds/orchestrator exec prisma migrate deploy
    ;;
esac

echo "[entrypoint] starting orchestrator in watch mode…"
# turbo runs ^build first (compiles @lds/shared + @lds/agent-runner),
# then the orchestrator's persistent `nest start --watch`.
exec pnpm exec turbo run dev --filter=@lds/orchestrator
