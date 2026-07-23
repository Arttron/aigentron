# Aigentron — Multi-Agent Autonomous Dev Platform

A self-hosted **orchestration platform** that runs a fleet of Claude Code agents for
autonomous development. This is the *control plane* around the agents, not the app they
write.

Two pillars:

- **Orchestrator** (`apps/orchestrator`) — NestJS REST API + WebSocket gateway. Owns the
  task lifecycle, spawns/supervises agents, routes models by tier, and gates dangerous
  tool calls behind human approval.
- **Dashboard** (`apps/dashboard`) — Vite + React SPA (CSS Modules), served same-origin
  by the orchestrator in production. Human ↔ agent communication, live logs, and approvals.

> **Status:** v1 skeleton — in active construction. See milestones in the build log /
> commit history. Auth/RBAC, multi-tenant, and production hardening are out of scope for
> v1 (marked as `TODO`).

## Quick start

```bash
cp .env.example .env   # fill in ANTHROPIC_API_KEY at minimum
make up                # build + start the full stack
```

Dashboard → http://localhost:3000 · Orchestrator API → http://localhost:3001

**First-run setup:** once the stack is up, `pnpm setup` (or `node infra/setup-wizard.mjs`)
runs a guided CLI wizard for providers, channels, agents, skills, and an optional project
repo — the same REST API the dashboard uses, just walked step by step from a terminal. The
dashboard keeps working standalone; the wizard is a guided alternative, not a replacement.

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

**Option A — installer script** (downloads a tagged release archive, builds, runs). Detects
Docker: if found and you're running this interactively (not piped), it **asks** whether to
install via Docker or directly on this system (bare-metal) — Docker being present doesn't
mean it's meant for Aigentron itself; it might be reserved for the project(s) your agents
will build/test in, with Aigentron meant to run bare-metal alongside it as the supervisor.
Piped `curl | sh` sessions can't be asked (no real stdin), so they default to Docker if
found, bare-metal otherwise:

```bash
curl -fsSL https://raw.githubusercontent.com/Arttron/aigentron/main/install.sh | sh
# or pin an explicit version — always do this for a real deployment:
VERSION=0.1.12 sh install.sh
# or skip the question entirely:
INSTALL_MODE=docker sh install.sh   # force Docker
INSTALL_MODE=bare sh install.sh     # force bare-metal (root required; see below)
```

Bare-metal mode needs root — piping straight into `sudo`, put env var overrides *after*
`sudo`, not before (`sudo` resets the environment by default, so e.g.
`VERSION=0.1.12 sudo sh install.sh` silently drops `VERSION`):
```bash
curl -fsSL https://raw.githubusercontent.com/Arttron/aigentron/main/install.sh | sudo INSTALL_MODE=bare VERSION=0.1.12 sh
```

Bare-metal mode builds from source and installs the exact same runtime (orchestrator,
which also serves the dashboard same-origin, + self-managed LiteLLM) as a systemd service,
using `infra/minimal-entrypoint.sh` directly instead of a container — requires root and, on the
host, Node ≥22/`pnpm`/`python3`/`git` (auto-installed if missing on apt/dnf/yum/apk systems;
`AUTO_INSTALL_DEPS=0` to just check and die instead). Installs into `/opt/aigentron` by
default (`INSTALL_DIR` to change it), data under `/opt/aigentron/data` (`DATA_DIR`), managed
with `systemctl {status,restart} aigentron` / `journalctl -u aigentron -f`. Docker mode
auto-installs Docker itself the same way if missing (`get.docker.com`).

On a real terminal (not piped), it also asks where to put things
(`INSTALL_DIR`/`DATA_DIR` — blank keeps the default shown), then checks free disk space on
every filesystem it'll actually write a lot to (install dir, data dir / Docker's own storage,
and the temp dir — which is sometimes a small RAM-backed tmpfs, independent of how much room
the root filesystem has) before downloading or building anything, rather than failing deep
into a build with a confusing "No space left on device" (`MIN_FREE_DISK_MB` to adjust the
5 GB default floor).

Prefer to skip the question and always get bare-metal, with a separate memorable URL:
```bash
curl -fsSL https://raw.githubusercontent.com/Arttron/aigentron/main/install-bare.sh | sudo sh
```
(a 3-line redirect that forces `INSTALL_MODE=bare` — no Docker involved, no question asked,
even if Docker happens to be present.)

Re-running the same command later checks the installed version (via `docker inspect` in
Docker mode, or the `/opt/aigentron/current` symlink in bare-metal mode) and upgrades in
place (`FORCE=1` to reinstall the same version). Never pin production to `latest`/unset —
that's an unpinned, unpredictable deploy.

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
  -p 3001:3001 \
  --add-host host.docker.internal:host-gateway \
  -v lds-data:/data \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  lds-minimal
```

Dashboard + Orchestrator API → http://localhost:3001 (same origin, one port). Everything
persists in the `/data` volume (SQLite DB, agent defs, repo, worktrees, attachments) —
back it up by copying that volume, nothing else to snapshot. `/api/health` reports the
running `version` alongside DB/LiteLLM status.

**Env vars worth overriding for a real deployment** (all have working local defaults — see
`ENV` in `infra/minimal.Dockerfile` for Docker mode, or the generated
`/etc/systemd/system/aigentron.service` for bare-metal mode):
- `ANTHROPIC_API_KEY` — for the cloud/"complex" model tier.
- `LITELLM_MASTER_KEY` — the image ships a fixed dev default; set your own.
- `ROUTINE_MODEL` / `OLLAMA_NATIVE_URL` — which local model to route to, and where Ollama
  actually is (defaults assume it's on the same host as the container).

**Ollama is optional.** It only backs one seeded provider (`ollama-local`) for the
"routine" local-model tier — if you only run tasks against cloud Claude (including the
CLI-minted subscription `oauth-token` auth mode — see `scripts/cli-auth.sh`), you can
leave `OLLAMA_NATIVE_URL` unreachable entirely: the app boots and runs fine either way,
that provider just errors if something tries to route to it.

**Accessing a remote deployment (e.g. an AWS instance) over SSH.** Rather than opening the
port to the internet, forward it through your existing SSH connection — the dashboard and
API now share the one port above (`minimal`/`bare-metal`: `ORCHESTRATOR_PORT`, default
`3001`), so a single tunnel covers both:

```bash
ssh -L 3001:localhost:3001 <user>@<remote-host>
```

Then open http://localhost:3001 locally — that's your dashboard, API, and the wizard's
target URL (`--orchestrator-url http://localhost:3001`) all at once. (Before this dashboard
rewrite, the dashboard and API lived on separate ports and needed two tunnels — one port is
the whole reason for the same-origin cutover.) Add `-i /path/to/key.pem` if the host needs a
specific key, and `-N` if you only want the tunnel (no remote shell). To also reach a
different local port, e.g. because `ORCHESTRATOR_PORT` was changed on the remote side, adjust
the first number: `ssh -L <local-port>:localhost:<remote-port> <user>@<remote-host>`.

**First-run setup:** every option above ends by printing how to run
`infra/setup-wizard.mjs` — a guided CLI walkthrough for providers, channels, agents,
skills, and an optional repo, instead of clicking through the dashboard by hand. It's a
plain REST client, so it works the same regardless of which option you used.

**Known follow-ups** (don't block using it, just not done yet): the runtime image ships
the full resolved `node_modules` rather than a production-pruned one (~3 GB); no container
registry yet, so every Docker path above builds locally rather than pulling a pre-built
image.
