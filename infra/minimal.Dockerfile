# syntax=docker/dockerfile:1
# ----------------------------------------------------------------------
# Minimal / single-container profile (docs/plan-single-container.md, Phase 4).
# One image runs BOTH apps + litellm as a child process the orchestrator itself
# spawns (LitellmManagedService, Phase 3) — no Redis, no Postgres, no separate
# litellm service. Storage is a SQLite file under /data (Phase 2). Contrast with
# infra/dev.Dockerfile, which is the `full` profile's dev image (bind-mounted
# source, hot-reload, real Postgres/Redis/litellm as their own services) — this
# image is a self-contained artifact meant for `docker run` on e.g. a small AWS
# instance, not for local development.
# ----------------------------------------------------------------------

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

# ---- deps: resolve the whole workspace, cached until a manifest changes ----
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json .npmrc ./
COPY apps/orchestrator/package.json apps/orchestrator/package.json
COPY apps/dashboard/package.json apps/dashboard/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/agent-runner/package.json packages/agent-runner/package.json
# better-sqlite3 needs a C++ toolchain to compile its native binding (approved
# non-interactively — see [[deploy-profiles-plan]] memory); openssl/git are for
# prisma/worktrees.
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl git python3 build-essential \
  && rm -rf /var/lib/apt/lists/*
RUN pnpm install --frozen-lockfile && pnpm approve-builds --all || true

# ---- build: compile both apps against the resolved deps ----
FROM deps AS build
WORKDIR /app
COPY . .
RUN pnpm --filter @lds/shared build && pnpm --filter @lds/agent-runner build
RUN pnpm --filter @lds/orchestrator build
RUN pnpm --filter @lds/dashboard build

# ---- runtime: node (both apps) + python (litellm child process) + uv (code-intel skill's Serena MCP) ----
FROM node:22-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl git ca-certificates curl python3 python3-venv \
  && rm -rf /var/lib/apt/lists/* \
  && python3 -m venv /opt/litellm-venv \
  && /opt/litellm-venv/bin/pip install --no-cache-dir 'litellm[proxy]' \
  # /usr/local/bin is already on this image's default PATH — the code-intel
  # skill's Serena MCP server spawns via `uvx`, which isn't installed by
  # default otherwise (only the full profile's dev image had it).
  && curl -LsSf https://astral.sh/uv/install.sh | UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh

WORKDIR /app

# Baked in at build time from the repo-root VERSION file (see publish/sync-public.sh
# and install.sh) so `docker inspect` always reflects what's actually running.
ARG VERSION=dev
LABEL org.opencontainers.image.version=$VERSION

# Orchestrator: compiled dist + prisma artifacts + the FULL resolved
# node_modules tree (pnpm workspace symlinks — not pruned to production-only
# yet; correctness over image size for this phase, see docs/plan-single-
# container.md Phase 4 follow-ups).
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/apps/orchestrator/dist /app/apps/orchestrator/dist
COPY --from=build /app/apps/orchestrator/node_modules /app/apps/orchestrator/node_modules
COPY --from=build /app/apps/orchestrator/prisma /app/apps/orchestrator/prisma
COPY --from=build /app/apps/orchestrator/prisma.sqlite.config.ts /app/apps/orchestrator/prisma.sqlite.config.ts
COPY --from=build /app/apps/orchestrator/src/generated/prisma-sqlite /app/apps/orchestrator/src/generated/prisma-sqlite
# pnpm doesn't hoist — a workspace package's OWN node_modules (symlinks into
# the root .pnpm store) must come along too, or its own deps 404. @lds/shared
# has none (types/utils only); @lds/agent-runner depends on zod + the SDK.
COPY --from=build /app/packages/shared/dist /app/packages/shared/dist
COPY --from=build /app/packages/shared/package.json /app/packages/shared/package.json
COPY --from=build /app/packages/agent-runner/dist /app/packages/agent-runner/dist
COPY --from=build /app/packages/agent-runner/package.json /app/packages/agent-runner/package.json
COPY --from=build /app/packages/agent-runner/node_modules /app/packages/agent-runner/node_modules

# Dashboard: a plain Vite SPA build — static HTML/CSS/JS with no runtime deps
# of its own, served in-process by the orchestrator (ServeStaticModule in
# app.module.ts). No relocation dance needed (contrast the old Next.js
# standalone-output copy this replaced).
COPY --from=build /app/apps/dashboard/dist /app/apps/dashboard/dist

# Agent operational files (skills, agent defs) — read at runtime, not compiled.
COPY agent /app/agent

COPY infra/minimal-entrypoint.sh infra/minimal-healthcheck.sh infra/setup-wizard.mjs /app/infra/
# The PreToolUse approval hook (apps/orchestrator's AppConfigService resolves
# it relative to its own compiled location, expecting it here) — previously
# missing from this COPY list entirely, so the hook script never existed in
# this image and every tool call silently fell through to the SDK's own
# interactive permission prompt instead of our auto-allow/human-approval gate.
COPY infra/hooks /app/infra/hooks
RUN chmod +x /app/infra/minimal-entrypoint.sh /app/infra/minimal-healthcheck.sh

ENV NODE_ENV=production \
    APP_VERSION=$VERSION \
    ORCHESTRATOR_PORT=3001 \
    DATABASE_URL=file:/data/orchestrator.db \
    LITELLM_MANAGED=1 \
    LITELLM_MANAGED_COMMAND=/opt/litellm-venv/bin/litellm \
    LITELLM_BASE_URL=http://127.0.0.1:4000 \
    LITELLM_MASTER_KEY=sk-lds-master-dev \
    OLLAMA_NATIVE_URL=http://host.docker.internal:11434 \
    WORKSPACE_SHARED=true \
    AGENT_DIR=/data/agent \
    WORKSPACE_REPO_PATH=/data/repo \
    WORKTREES_ROOT=/data/worktrees \
    ATTACHMENTS_DIR=/data/agent/attachments \
    DASHBOARD_BASE_URL=http://localhost:3001

VOLUME /data
EXPOSE 3001

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD ["/app/infra/minimal-healthcheck.sh"]

ENTRYPOINT ["/app/infra/minimal-entrypoint.sh"]
