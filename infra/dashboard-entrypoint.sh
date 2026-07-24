#!/usr/bin/env sh
# ----------------------------------------------------------------------
# Dev entrypoint for the dashboard container. Runs against the bind-mounted
# source; turbo builds @lds/shared (^build) before starting the Vite dev server.
# ----------------------------------------------------------------------
set -e

# See infra/orchestrator-entrypoint.sh's identical stamp check for why: a
# frozen-lockfile install isn't free even as a no-op, and this container
# restarts often during a dev session.
LOCKFILE_STAMP="node_modules/.pnpm-lockfile-hash"
LOCKFILE_HASH=$(sha256sum pnpm-lock.yaml | cut -d' ' -f1)
if [ -f "$LOCKFILE_STAMP" ] && [ "$(cat "$LOCKFILE_STAMP")" = "$LOCKFILE_HASH" ]; then
  echo "[dashboard] dependencies unchanged since last install — skipping pnpm install"
else
  echo "[dashboard] syncing dependencies (frozen lockfile)…"
  pnpm install --frozen-lockfile --prefer-offline
  echo "$LOCKFILE_HASH" > "$LOCKFILE_STAMP"
fi

echo "[dashboard] starting vite dev (watch)…"
exec pnpm exec turbo run dev --filter=@lds/dashboard
