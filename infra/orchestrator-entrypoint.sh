#!/usr/bin/env sh
# ----------------------------------------------------------------------
# Dev entrypoint for the orchestrator container.
# Runs against the bind-mounted source tree, so Prisma client generation
# and migrations happen here (not at image build) to land in the mount.
# ----------------------------------------------------------------------
set -e

# pnpm install --frozen-lockfile is a correctness check (fails on drift), but
# it's not free even when nothing changed — every container restart during a
# dev session (and there are many: EADDRINUSE recovery, hot-reload edge cases)
# paid its full cost again. node_modules is a docker-managed anonymous volume
# (persists across restarts, only reset by a genuine volume recreate), so a
# stamp of the lockfile's hash there is a safe "did dependencies actually
# change since last install" check.
LOCKFILE_STAMP="node_modules/.pnpm-lockfile-hash"
LOCKFILE_HASH=$(sha256sum pnpm-lock.yaml | cut -d' ' -f1)
if [ -f "$LOCKFILE_STAMP" ] && [ "$(cat "$LOCKFILE_STAMP")" = "$LOCKFILE_HASH" ]; then
  echo "[entrypoint] dependencies unchanged since last install — skipping pnpm install"
else
  echo "[entrypoint] syncing dependencies (frozen lockfile)…"
  pnpm install --frozen-lockfile --prefer-offline
  echo "$LOCKFILE_HASH" > "$LOCKFILE_STAMP"
fi

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
