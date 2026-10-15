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

> **Status:** active development (current release: see the `VERSION` file). Shipped: per-user
> password sign-in with roles ([`docs/authentication.md`](docs/authentication.md)), provider failover,
> structured task status with a watchdog, Telegram channel, scheduler, Codex runtime, knowledge bases,
> camera/video/vision, voice, discussions between agents, starter packs, learned skills, in-place
> updates, a shared workspace (memory / drafts / deliverables, page `/workspace`). Not done: multi-tenancy, OS-level isolation of agents from the orchestrator, Slack/email
> channels. Plan: [`docs/roadmap.md`](docs/roadmap.md) and [`docs/BACKLOG.md`](docs/BACKLOG.md).

## Quick start

```bash
cp .env.example .env   # fill in ANTHROPIC_API_KEY at minimum
make up                # build + start the full stack
```

Dashboard → http://localhost:3000 · Orchestrator API → http://localhost:3001

**One command on the server:** `aigentron` opens the setup menu (providers, channels, agents, repository); `aigentron status | logs | restart | update | rollback | backup | restore | admin | reset-password | help` do the rest. The installer puts it on your PATH.

**First-run setup:** once the stack is up, `pnpm setup` (or `node infra/setup-wizard.mjs`)
runs a guided CLI wizard for providers, channels, agents, skills, and an optional project
repo — the same REST API the dashboard uses, just walked step by step from a terminal. The
dashboard keeps working standalone; the wizard is a guided alternative, not a replacement.
It can be re-run any time to **edit** what is already set up: provider model / base URL / secret, and channel settings (e.g. add your Telegram chat id, or allow a chat that has already written to the bot).

## Running locally with Docker Compose

### Prerequisites

- Docker Desktop (or Docker Engine + Compose v2).
- Optional: [Ollama](https://ollama.com) installed and running **on the host** (not in a
  container) — it backs the local "routine" model provider. The orchestrator container reaches
  it at `http://host.docker.internal:11434`. Without it, use cloud / subscription providers only.
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
   - `ANTHROPIC_API_KEY` — for the cloud Claude provider (or sign in with a subscription token instead — see the minimal-profile section).
   - `ROUTINE_MODEL` — only if you use local Ollama: a tool-capable model pulled into your host Ollama (default
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

   A second, proxied browser (`--profile proxy`, credentials from `.env`) is described in
   [`docs/browser-proxy.md`](docs/browser-proxy.md).

5. **Open the dashboard** at http://localhost:3000. The orchestrator API is at
   http://localhost:3001.

### Useful commands

```bash
make logs     # tail logs for all services
make ps       # show service status
make migrate  # run Prisma migrations inside the orchestrator container
make admin    # chat with the built-in admin assistant in the terminal
make test     # unit tests + the admin-skills drift check
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

> **Admin assistant from the terminal:** `aigentron-admin` (bare-metal/minimal image) or `make admin` (dev compose) opens the
> same chat as the dashboard bubble — handy for first-time setup on a headless server. Approvals are answered at the prompt and
> API keys are typed into a hidden prompt that goes straight to the server, never through the chat.
>
> Where the project, agent files, secrets and env files live in each mode, and how cleanup works:
> [`docs/workspace-layout.md`](docs/workspace-layout.md).
>
> Features: [media (camera, video, vision, pictures)](docs/media.md) · [questions with buttons](docs/questions.md) · [knowledge bases](docs/knowledge-base.md) · [discussion between agents](docs/discussions.md) · [browser through a proxy](docs/browser-proxy.md) · [voice](docs/voice.md) · [resources](docs/resources.md) · [starter packs](docs/packs.md) · [sign-in](docs/authentication.md) · [any language / token policy](docs/languages.md) · [updates](docs/updates.md) · [shared workspace](docs/workspace-layout.md) · [how a request is built](docs/request-flow.md).

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

The installer verifies the release archive against its `SHA256SUMS`, generates random `LITELLM_MASTER_KEY` / `LDS_HOOK_SECRET` on a fresh install, and (fresh install only) sets a random
operator password through the local API and prints it once (also `<data>/secrets/initial-password.txt`, 0600; `NO_INITIAL_PASSWORD=1` skips). A bare-metal update stops the service, snapshots the database, migrates, starts the new
release and waits for `/api/health` - if it does not come up it rolls back by itself (release and database). `aigentron backup` / `aigentron restore` back up and restore everything (`docs/updates.md`). Behind Cloudflare on 80/443:
open those ports only to Cloudflare's ranges and keep 3001 closed (`docs/remote-access.md`).

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
persists in the `/data` volume (SQLite DB, agent defs, repo, shared workspace, worktrees, attachments) —
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
