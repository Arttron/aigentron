# Aigentron — Multi-Agent Autonomous Dev Platform

A self-hosted **orchestration platform** that runs a fleet of Claude Code agents for
autonomous development. This is the *control plane* around the agents, not the app they
write.

Two pillars:

- **Orchestrator** (`apps/orchestrator`) — NestJS REST API + WebSocket gateway. Owns the
  task lifecycle, spawns/supervises agents, routes models by tier, and gates dangerous
  tool calls behind human approval.
- **Dashboard** (`apps/dashboard`) — Next.js (App Router) + Tailwind. Human ↔ agent
  communication, live logs, and approvals.

> **Status:** v1 skeleton — in active construction. See milestones in the build log /
> commit history. Auth/RBAC, multi-tenant, and production hardening are out of scope for
> v1 (marked as `TODO`).

## Quick start

```bash
cp .env.example .env   # fill in ANTHROPIC_API_KEY at minimum
make up                # build + start the full stack
```

Dashboard → http://localhost:3000 · Orchestrator API → http://localhost:3001

## Running locally with Docker Compose

### Prerequisites

- Docker Desktop (or Docker Engine + Compose v2).
- [Ollama](https://ollama.com) installed and running **on the host** (not in a
  container) — it powers the "routine" model tier. The orchestrator container reaches
  it at `http://host.docker.internal:11434`.
- A one-time external Docker network, shared with the project's own compose stack so
  agents can reach project databases by service name:

  ```bash
  docker network create lds-agents
  ```

### Steps

1. **Configure environment**

   ```bash
   cp .env.example .env
   ```

   Fill in at minimum:
   - `ANTHROPIC_API_KEY` — required for the "complex" model tier (cloud Claude).
   - `ROUTINE_MODEL` — a tool-capable model pulled into your host Ollama (default
     `qwen3-coder:30b`; avoid `qwen2.5-coder` — it doesn't emit structured tool calls
     and breaks the agent SDK).

2. **Pull the routine-tier model into the host's Ollama** (not into a container):

   ```bash
   ollama pull qwen3-coder:30b   # or whatever ROUTINE_MODEL is set to
   ```

3. **Build and start the stack**

   ```bash
   make up
   # equivalent to: docker compose up -d --build
   ```

   This brings up Postgres, Redis, LiteLLM (Anthropic-compatible proxy in front of
   Ollama), the orchestrator (`:3001`), and the dashboard (`:3000`), all bind-mounted
   for hot-reload. First boot is slower — the orchestrator compiles `packages/shared`
   and `packages/agent-runner` before its healthcheck passes.

4. **(Optional) Browser automation profile** — Playwright MCP and a dev server for the
   project under `./project`, used by frontend/design agents:

   ```bash
   docker compose --profile mcp up -d
   ```

5. **Open the dashboard** at http://localhost:3000. The orchestrator API is at
   http://localhost:3001.

### Useful commands

```bash
make logs     # tail logs for all services
make ps       # show service status
make migrate  # run Prisma migrations inside the orchestrator container
make down     # stop the stack
make clean    # stop the stack AND remove volumes (destructive — wipes DB data)
```

More detailed setup, the model-routing model, and how the approval gate works are
documented further down as the system is built out.

## Server deployment — minimal single-container profile

An alternative to the multi-service Compose stack above, for running the platform on a
remote server (e.g. a small AWS instance) as **one container**: orchestrator + dashboard
+ LiteLLM (as a process the orchestrator itself spawns) — no Postgres, no Redis, no
separate LiteLLM service. SQLite + an in-process queue replace them. Full design in
[`docs/plan-single-container.md`](docs/plan-single-container.md).

**Status:** builds and runs correctly (verified end to end, including a real agent task
against a real local Ollama through the self-managed LiteLLM). No container registry is
involved — every path below builds `infra/minimal.Dockerfile` locally from source; the
`VERSION` file at repo root and the image's `org.opencontainers.image.version` label (check
with `docker inspect`) are the source of truth for what's actually running.

**Option A — installer script** (downloads a tagged release archive, builds, runs):

```bash
curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/main/install.sh | sh
# or pin an explicit version — always do this for a real deployment:
VERSION=0.1.0 sh install.sh
```

Re-running the same command later checks the installed version via `docker inspect` and
upgrades in place (`FORCE=1` to reinstall the same version). Never pin production to
`latest`/unset — that's an unpinned, unpredictable deploy.

**Option B — docker compose**, for building straight from a local checkout of this repo.
Uses `.env.minimal`, **not** the root `.env` — the latter is the multi-service `full`
profile's template (real Postgres/Redis hostnames) and would override this image's own
baked-in SQLite/embedded-queue defaults if used here:

```bash
cp .env.minimal.example .env.minimal   # fill in ANTHROPIC_API_KEY etc.
docker compose --env-file .env.minimal -f docker-compose.minimal.yml up -d --build
```

**Option C — plain docker**, building from a local checkout without compose:

```bash
docker build --build-arg VERSION="$(cat VERSION)" -f infra/minimal.Dockerfile -t lds-minimal .
docker run -d --name lds \
  -p 3000:3000 -p 3001:3001 \
  --add-host host.docker.internal:host-gateway \
  -v lds-data:/data \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  lds-minimal
```

Dashboard → http://localhost:3000 · Orchestrator API → http://localhost:3001. Everything
persists in the `/data` volume (SQLite DB, agent defs, repo, worktrees, attachments) —
back it up by copying that volume, nothing else to snapshot. `/api/health` reports the
running `version` alongside DB/LiteLLM status.

**Env vars worth overriding for a real deployment** (all have working local defaults —
see `ENV` in `infra/minimal.Dockerfile`):
- `ANTHROPIC_API_KEY` — for the cloud/"complex" model tier.
- `LITELLM_MASTER_KEY` — the image ships a fixed dev default; set your own.
- `ROUTINE_MODEL` / `OLLAMA_NATIVE_URL` — which local model to route to, and where Ollama
  actually is (defaults assume it's on the same host as the container).

**Known follow-ups** (don't block using it, just not done yet): the runtime image ships
the full resolved `node_modules` rather than a production-pruned one (~3 GB); no container
registry yet, so every path above builds locally rather than pulling a pre-built image.
