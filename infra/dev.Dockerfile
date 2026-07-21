# syntax=docker/dockerfile:1
# ----------------------------------------------------------------------
# Shared development image for the Node workspaces (orchestrator + dashboard).
# Source is bind-mounted at runtime (see docker-compose.yml); this image only
# bakes the toolchain + an installed node_modules so the watchers hot-reload.
# Each service supplies its own entrypoint via compose (bind-mounted scripts).
# ----------------------------------------------------------------------
FROM node:22-bookworm-slim AS dev

# git -> per-task git worktrees; openssl -> Prisma engine; ca-certificates -> TLS
RUN apt-get update \
  && apt-get install -y --no-install-recommends git openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# uv / uvx — runtime for stdio MCP servers like Serena (code-intel).
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/

# Pre-warm the uv cache with Serena so code-intel's first spawn is fast
# instead of a ~2min cold git-clone + dependency build (during which the SDK
# reports `code-intel=pending` and early tool calls fail). UV_CACHE_DIR is
# baked and re-read at runtime, so the runtime `uvx … serena start-mcp-server`
# reuses this environment. Tracks the repo's default branch; if upstream moves
# past what's cached, uvx rebuilds on next spawn and the next image build
# re-warms. `|| true` so a transient network hiccup can't fail the build.
ENV UV_CACHE_DIR=/opt/uv-cache
RUN uvx --from git+https://github.com/oraios/serena serena --help >/dev/null 2>&1 || true

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NODE_ENV=development \
    CI=true
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
# Fixed store path baked into the image (see infra notes) keeps node_modules
# consistent on boot so installs stay non-interactive.
RUN pnpm config set store-dir /pnpm/store --global

WORKDIR /app

# Dependency layer: copy every workspace manifest so a single `pnpm install`
# resolves the whole workspace and is cached until a package.json changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/orchestrator/package.json apps/orchestrator/package.json
COPY apps/dashboard/package.json apps/dashboard/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/agent-runner/package.json packages/agent-runner/package.json

RUN pnpm install --frozen-lockfile

EXPOSE 3000 3001
