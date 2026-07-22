#!/usr/bin/env sh
# ----------------------------------------------------------------------
# Dev entrypoint for the dashboard container. Runs against the bind-mounted
# source; turbo builds @lds/shared (^build) before starting the Vite dev server.
# ----------------------------------------------------------------------
set -e

echo "[dashboard] syncing dependencies (frozen lockfile)…"
pnpm install --frozen-lockfile --prefer-offline

echo "[dashboard] starting vite dev (watch)…"
exec pnpm exec turbo run dev --filter=@lds/dashboard
