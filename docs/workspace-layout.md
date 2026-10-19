# Workspace layout, environment files and housekeeping

> Reference for "where does everything live and who reads which setting". Verified against the code and a live
> dev stack on 2026-10-08. The admin agent's dashboard guide (`agent/skills/core/admin/dashboard-guide.md`) carries the
> user-facing parts — keep both in step.

## 1. The pieces

| Thing | What it is |
|---|---|
| **Default project** (`WORKSPACE_REPO_PATH`) | The repository the agents work on when no other project is chosen. Real checkout of *your* project (e.g. `tesla-info`). It is the checkout of the project `default` (`Project.repoPath`, adopted in place at every boot). |
| **Shared workspace** (`WORKSPACE_DIR`) | Non-code results of the agents, one folder next to the repo and the agent dir (`/workspace/workspace` dev — bind-mounted from host `./workspace` via `WORKSPACE_HOST_PATH`; `/data/workspace` minimal; `$DATA_DIR/workspace` bare). Created automatically, never overwritten: `WORKSPACE.md` (brief — a person edits it), `memory/` (`decisions.md`, `questions.md`, `facts.md`, `plan.md`, `status.md` — written with `workspace_note`), `work/` (drafts, data), `deliverables/` (results via `workspace_save`, the newest 5 older versions of each file in `.versions/`, none older than 90 days). It is the folder of the project `default`. Design: `docs/plan-projects-workspace.md`. |
| **Projects dir** (`PROJECTS_DIR`) | Every other project: `<PROJECTS_DIR>/<slug>/` with the same layout as the shared workspace (`PROJECT.md` as the brief, `memory/`, `work/`, `deliverables/`) plus its checkout in `repo/` (unless `Project.repoPath` points elsewhere). A docs project has no checkout: its tasks work in `work/`. Sibling of the agent dir by default: `/workspace/projects` (compose), `/data/projects` (minimal), `$DATA_DIR/projects` (bare). |
| **Agent dir** (`AGENT_DIR`) | The platform's own files: `agents/` (live agents), `skills/`, `catalog/` (templates), `builtin/` (admin), `packs/` (starter packs), `resources/` (the shared library, `docs/resources.md`), `runs/<taskId>/` (per-task working files), `attachments/<taskId>/`, `cache/digests/<hash>/` (video frames + transcripts, regenerable), `research-cache/`, `research.json`, `admin-audit.jsonl`, `.sync/`, `.snapshots/`. Knowledge bases (`docs/knowledge-base.md`) live in the database, not here. |
| **Secrets dir** (`SECRETS_DIR`, default sibling `…/secrets`) | Credentials and access settings that must not sit in the agent tree: the shared Codex sign-in (`secrets/codex/auth.json`), `auth.json` (password hashes + session key, `docs/authentication.md`), `access.json` (allowed domains), `cloudflare-access.json`, `web-server.json` + `tls/` (`docs/remote-access.md`), `voice.json` (`docs/voice.md`). |
| **Worktrees root** (`WORKTREES_ROOT`) | Per-task git worktrees, nested per project: `<root>/<slug>/<taskId>` — only for projects in worktree isolation (`Project.isolation = worktree`, or `WORKSPACE_SHARED=false` when the project follows the installation). Flat `<root>/<taskId>` folders from before projects are understood by the cleanup. |
| **Database** | Postgres (full/dev) or one SQLite file (minimal/bare). |

## 2. Paths per deployment mode

| | Dev — `docker compose` | Minimal — one container | Bare-metal — systemd |
|---|---|---|---|
| Project | host `./project` → `/workspace/repo` (`PROJECT_HOST_PATH`) | `/data/repo` | `$DATA_DIR/repo` |
| Agent dir | host `./agent` → `/workspace/agent` (`AGENT_HOST_PATH`) | `/data/agent` | `$DATA_DIR/agent` |
| Shared workspace | host `./workspace` → `/workspace/workspace` (`WORKSPACE_HOST_PATH`) | `/data/workspace` | `$DATA_DIR/workspace` |
| Secrets | named volume `secrets` → `/workspace/secrets` | `/data/secrets` | `$DATA_DIR/secrets` |
| Worktrees | named volume `worktrees` → `/workspace/.worktrees` | `/data/worktrees` | `$DATA_DIR/worktrees` |
| Database | volume `pgdata` (Postgres), `redisdata` (Redis) | `/data/orchestrator.db` (SQLite) | `$DATA_DIR/orchestrator.db` |
| App code | repo bind-mounted at `/app` (hot reload) | baked into the image at `/app` | `$INSTALL_DIR/releases/<v>`, symlink `current` |
| Env file | `.env` in the repo root | env vars / `.env.minimal.example` | `$INSTALL_DIR/.env` (systemd `EnvironmentFile`) |
| Defaults | — | `DATA_DIR=/data` | `INSTALL_DIR=/opt/aigentron`, `DATA_DIR=$INSTALL_DIR/data` |

Notes
- In **dev** the agent dir and the "shipped" agent files are the same directory (`agent/` is both the live copy and the
  repo source), so `AgentFilesSyncService` does nothing there; in minimal/bare the live copy lives in `/data/agent` and is
  3-way-merged from the release on boot. The built-in admin is seeded once from `builtin/admin.md` and kept current by the same sync.
- `agent/agents/`, `agent/runs/`, `agent/attachments/`, `agent/.sync/`, `agent/.snapshots/` are git-ignored (and docker-ignored).
- Changing `SECRETS_DIR` / `CODEX_AUTH_HOME` is possible but rarely needed; an older sign-in found in `agent/.codex-home` or `~/.codex`
  is migrated/used automatically.

### Console access to the admin agent

`infra/admin-cli.mjs` (zero dependencies, Node ≥ 18) is the terminal client of the built-in admin: `aigentron-admin` is installed on PATH by the
bare-metal installer and baked into the dev/minimal images (`make admin` in dev compose). It talks to `http://127.0.0.1:3001` (or `LDS_URL` /
`--url`), keeps the last chat id in `$XDG_STATE_HOME/aigentron/admin-chat.json`, signs in like the dashboard when passwords are set (session kept in `$XDG_STATE_HOME/aigentron/admin-session.json`, `docs/authentication.md`; without passwords it acts as the default operator unless `--user <id>` is given),
answers approval cards in the terminal and reads secrets through a hidden prompt (`POST /api/approvals/:id/secret`).

## 3. How agents see the project

- **One project per task.** Every task belongs to a project (`Task.projectId`; the default project unless another slug was given,
  a subtask follows its lead). The worker resolves the task's project ONCE per job (`ProjectsService.contextFor`) and everything
  below — checkout, mode, cwd, verify commands and attempts, write roots, the `workspace_*` folder, the default lead, the
  escalation chat — comes from that project. The global Settings → General repository fields are the default project's
  (a write there is mirrored into the project row). Git credentials are the project's (`docs/projects.md`: token / SSH key files
  in the secrets dir, `GIT_CREDENTIALS` port) and travel in the env of EACH git command — clone/fetch (`RepoSyncService`),
  worktree creation, push; nothing is written into a checkout's `.git/config`, so agents never hold a secret. Providers and
  MCP servers are shared by all projects; the `github` MCP server's `GITHUB_TOKEN` for a run is the task's project's token
  (the legacy global token, then the server's own config, as fallbacks).
- **Shared mode** (`Project.isolation = shared`, or `WORKSPACE_SHARED=true` when the project follows the installation — the
  default in all profiles): every task of the project works directly in the project's checkout, one task of that project at a
  time (an in-process FIFO lock per project in the worker). Tasks of DIFFERENT projects run side by side under the global
  concurrency cap (Settings → General): a task waiting for its project's lock lends its slot to the others, so a busy project
  never starves the rest; a lead never holds the lock while it waits for its subtasks. No per-task branch or PR; the agents
  edit whatever branch is currently checked out. If a repo URL + credentials are configured the orchestrator pushes the
  current branch to the project's remote. With only the default project this is exactly the old behaviour (the seeded
  concurrency is still 1 in shared mode — raise it in Settings to run projects in parallel).
- **Workspace tools and boundary.** Besides the checkout, every working agent may write inside ITS project's folder (an extra write root in the approval hook, `LDS_EXTRA_WRITE_ROOTS`: the shared workspace for the default project, `<PROJECTS_DIR>/<slug>` for the others; never another project's); the prompt gets a short block with the folders plus a memory digest (brief, status, last 15 decisions, open questions; ≤ ~6 KB, last in the prompt) and names the project in the orientation. Tools (`workspace_info`, `workspace_files`, `workspace_note`, `workspace_save`) are free and bound to the task's project folder; discussion participants only get info/files. The media tools (`look_at`, `show_images`, `video_digest`, `read_document`, `ask_user` pictures) accept files of the task's attachments, the resource library, the task's checkout and its own project folder — not other projects'. A file saved with `workspace_save` is also listed in the task's attachments as a **link** (no copy: `<attachments>/<taskId>/.links.json` maps the listed name to the file; only files of the workspace, the projects dir or the resource library, re-checked on every read; the entry vanishes if the source is deleted; deleting the task removes the link, never the file). Answers to `ask_user` are appended to the project's `decisions.md` automatically. Existing installs need no migration — the folder simply appears. A person sees the default project's folder on the dashboard page **📁 Workspace** (`/workspace`): browse, preview Markdown/text/images/PDF, download, upload into `work/`, delete in `work/`/`deliverables/`, edit the brief; API `GET /api/workspace`, `GET /api/workspace/files?path=`, `GET|PUT|DELETE /api/workspace/file?path=` (writes only in `work/` and `WORKSPACE.md`, operator/admin; no symlink out; html/svg/js only download). Its size — and every project's folder and checkout — is in Settings → General → Disk & cleanup (`GET /api/maintenance/report` → `projects[]`) and is never cleaned automatically.
- **Worktree mode** (`Project.isolation = worktree`, or `WORKSPACE_SHARED=false`): each task gets `agent/task-<id>` in its own worktree
  under `WORKTREES_ROOT/<slug>/`; on success the branch is pushed to the project's remote and a PR opened (GitHub remotes; the PR
  API still uses the installation's token). Tasks of such a project run in parallel.
- **Docs projects** (`Project.kind = docs`): no checkout, no verify, no push; the agent's working directory is the project's `work/`.
- The agent's working directory is the checkout root, or the project's *subdirectory* (`Project.repoSubdir`; the default project's
  comes from *Project subdirectory* in Settings → General — a **relative folder inside the repo**, validated; empty = root). Chat
  agents (the admin) run in the agent dir instead and have no file tools.
- Verify commands and the number of fix attempts are the project's (`Project.verifyCommands` / `verifyMaxAttempts`; the default
  project's are the Settings → General values). A task without an agent gets the project's `defaultAgent`, else the global one; a
  blocked task without a chat thread escalates to the project's notification chat, else the global one (Settings → Escalations).
- Approvals gate risky actions; reads of credential files (`.env*`, `auth.json`, `.git/config`, `/proc/*/environ`, `secrets/`, ssh/cloud keys)
  need approval. Note the project itself may contain such files (`.env.local`, `.env.production`…) — they are gated, not hidden.
- With agent isolation on (`AGENT_RUN_AS_UID`, `docs/authentication.md`) the agent is a separate OS user: `secrets/`, the database,
  `.env`, `backups/` and the LiteLLM routes file are closed to it by permissions; `repo/`, `worktrees/*`, `workspace/`, `projects/*`
  (each project's folder with its checkout), `agent/attachments/` and `agent/runs/<task>/{home,codex-home}` belong to that user (the
  orchestrator re-applies this before every run for the task's own project; `infra/harden.sh` on every start). Files an agent creates
  are owned by uid 1500 — root reads them as usual.

## 4. Environment files — who reads what

| File | Used by | Notes |
|---|---|---|
| `.env.example` | humans | Template with every documented setting. `make init-env` copies it to `.env` and generates a random `LITELLM_MASTER_KEY` on a **fresh** install. |
| `.env` (dev) | `docker compose` (`env_file`) **and** the orchestrator process itself | The process loads `.env` via dotenvx, which *replaces* `process.env`: a variable set only in compose `environment:` is **not** visible to the Node process (use `.env`; `BIND_ADDRESS` is handed over via `/tmp/lds-bind-address` for exactly this reason). |
| `.env.minimal.example` | humans | Starter for the minimal/bare install (`APP_VERSION`, provider seed values, `LITELLM_MASTER_KEY`, `MCP_TOKEN`, …). |
| `$INSTALL_DIR/.env` (bare) | systemd `EnvironmentFile` | Written on first install from the example. |
| `agent/research.json` | research MCP | Optional: `{"jurisdictions": {"eu": ["eur-lex.europa.eu"]}}` replaces the built-in official-source list. |

### Variables that decide paths, exposure and housekeeping

| Variable | Default | Meaning |
|---|---|---|
| `WORKSPACE_REPO_PATH`, `WORKSPACE_DIR`, `PROJECTS_DIR`, `WORKTREES_ROOT`, `AGENT_DIR`, `ATTACHMENTS_DIR`, `SECRETS_DIR` | see §2 (`WORKSPACE_DIR` / `PROJECTS_DIR` default: next to the agent dir) | Container/process paths. |
| `PROJECT_HOST_PATH`, `AGENT_HOST_PATH`, `WORKSPACE_HOST_PATH` | `./project`, `./agent`, `./workspace` | Host side of the dev bind mounts. |
| `WORKSPACE_SHARED` | `true` (set by compose and the minimal/bare profiles; the code default without it is `false`) | Shared vs worktree mode (§3). |
| `BIND_ADDRESS` | `127.0.0.1` | Host interface the **dev compose** ports are published on. `0.0.0.0` exposes dashboard, API, LiteLLM, Postgres, Redis — they have no authentication. Minimal/bare listen on all interfaces; protect them with a firewall/VPN. |
| `ORCHESTRATOR_PORT`, `DASHBOARD_PORT`, `POSTGRES_HOST_PORT`, `REDIS_HOST_PORT` | 3001, 3000, 5432, 6379 | Host ports (your `.env` may shift them, e.g. 3011/3088/5434/6381). |
| `LITELLM_MASTER_KEY` | public dev default if unset | Must be random when anything is reachable from a network. `make init-env` sets it on fresh installs only (changing it under an existing LiteLLM database would orphan stored routes). |
| `MCP_HOST_ENABLED`, `MCP_TOKEN` | `true`, empty | The `/api/mcp` entry point; set a token if exposed. |
| `CODEX_AUTH_HOME`, `CODEX_BIN` | `<secrets>/codex`, `codex` | Shared ChatGPT sign-in location / binary. |
| `BRAVE_API_KEY` or `RESEARCH_SEARXNG_URL` | unset | Search backend for the research MCP (fetch works without). |
| `RUNS_RETENTION_DAYS` | `14` (`0` = never) | Run folders older than this are removed (never for live tasks). |
| `DIGEST_RETENTION_DAYS`, `RESEARCH_CACHE_RETENTION_DAYS` | `30`, `180` (`0` = never) | Cached video digests (frames + transcript, `agent/cache/digests/`) and fetched web pages older than this are removed automatically — both are regenerated on demand. |
| `ATTACHMENTS_RETENTION_DAYS` | `0` (= never; **off by default**) | When set, the attachments of tasks that *finished* more than this many days ago (and leftover folders of deleted tasks) are removed in the 6-hourly tidying. Your own files — switch it on only if the disk is small. Live tasks and tasks active within the period are never touched; linked workspace / library files are never deleted (only the link). |
| `DISK_WARN_PERCENT`, `DISK_WARN_GB`, `DISK_CRITICAL_PERCENT`, `DISK_CRITICAL_GB` | `15`, `3`, `7`, `1` | Free-space limits (see "Disk space" below). The percentage is capped on big disks (warn under 20 GB, critical under 8 GB). |
| `WORKTREE_RETENTION_DAYS`, `CLEANUP_WORKTREES` | `30`, `false` | Old worktrees are only removed on request (admin → *propose_cleanup*, or `POST /api/maintenance/cleanup`), unless `CLEANUP_WORKTREES=true`. |
| `PUBLIC_URL`, `ORCHESTRATOR_HOST`, `WEB_HOST`, `TUNNEL_TOKEN`, `TRUSTED_PROXY` | unset / `0.0.0.0` | Addresses and tunnel — `docs/remote-access.md`. |
| `ADMIN_PASSWORD`, `AUTH_SESSION_DAYS` | unset, `30` | First password / session length — `docs/authentication.md`. |
| `UPDATE_ENABLED`, `UPDATE_REPO` | on, `Arttron/aigentron` | Self-update — `docs/updates.md`. |
| `QUESTION_TIMEOUT_SECONDS`, `SUBTASK_LIMIT`, `IMAGE_MAX_SIDE` | `3600`, `25`, `1600` | How long `ask_user` waits (`docs/questions.md`), subtasks per task (`docs/request-flow.md`), longest picture side (`docs/media.md`). |

## 4a. Disk space

- **Monitoring:** the server reads the free space of the data disk every 10 minutes. When it drops below the *warn* limit a banner appears across the dashboard, Settings → General → **Disk & cleanup** shows the numbers and what takes the space, and a message goes to the default notification chat (Settings → Escalations) — or, if none is set, to every allowed chat of every enabled channel (at most every 12 h while it stays low).
- **Automatic relief at *critical*:** all video digests, fetched pages older than 30 days and run folders older than 3 days are removed by the server itself (once per 6 h). Never your files, tasks, notes or knowledge bases. **Free up space now** does the same on demand (`POST /api/maintenance/relieve`).
- **Regular tidying (every 6 h):** run folders (14 days), video digests (30 days), fetched pages (180 days). Task attachments (your files) are only *reported* unless you set `ATTACHMENTS_RETENTION_DAYS` — the report shows how much belongs to tasks finished more than 90 days ago (and the retention in force); delete those tasks yourself or ask the admin.
- **Container logs** are rotated (3 × 20 MB per container) in the compose file and in the installer's `docker run`.
- What is *not* handled yet: database growth (events/sessions of old tasks) and old Docker images kept for rollback — `aigentron doctor` and `docker system df` show them.

## 5. What to back up

| Data | Where |
|---|---|
| Tasks, settings, providers (incl. keys), users | Postgres `pgdata` / SQLite file |
| Your project | `./project` (`/data/repo`) — it is your git repository |
| Your agents, custom skills, attachments | `agent/agents/`, `agent/skills/core/custom/`, `agent/skills/learned/`, `agent/attachments/` |
| Dashboard passwords, domain list, certificate, voice settings, ChatGPT/Codex sign-in | `secrets` volume (losing `auth.json` = no passwords; re-sign-in to Codex is fine) |
| Shared workspace (memory, drafts, deliverables) | `workspace/` (`./workspace` in dev, `<data>/workspace` in minimal/bare) |
| Library (resources) | `agent/resources/` (`<data>/agent/resources/` in minimal/bare) |
| Disposable | `agent/runs/`, `agent/cache/`, `agent/research-cache/` (reproducible), `worktrees` volume, `pnpm-store` |

## 6. Housekeeping and its safety rules

- `GET /api/maintenance/disk` — free space, level and what takes it; `POST /api/maintenance/relieve` — free up space now (§4a).
- `GET /api/maintenance/report` — counts/sizes of run folders, old worktrees and `agent/task-*` branches.
- `POST /api/maintenance/cleanup` — **dry run unless `"dryRun": false`**; options `runs`, `worktrees`, `deleteBranches`, `olderThanDays`.
- Scheduled (every 6 h): run folders past retention, video digests and fetched pages past theirs, attachments of finished tasks only when `ATTACHMENTS_RETENTION_DAYS` is set (§4a). Credentials are scrubbed from run folders on every boot, and after every Codex run.
- Worktrees are removed *without* deleting their `agent/task-*` branches (commits may never have been pushed); branches go only with
  `deleteBranches`. Orphaned directories under the worktrees root (no longer known to git) are handled the same way.
- A Codex follow-up whose run folder was cleaned up continues in a fresh thread (with a notice) instead of failing.

## 7. Known caveats

- Concurrency in Settings is the cap for all projects together; tasks of one shared-mode project still run one at a time. Installs
  made in shared mode were seeded with 1 — raise it to run several projects at once. Chat turns (the admin) no longer queue
  behind a running task.
- Settings → General still shows the repository / subdirectory / verify fields: they are the default project's (writes are
  mirrored into the project row; a change made through `PATCH /api/projects/default` is not shown back there yet).
- The project often carries its own `.env.*` files; they are inside the agents' working directory.
- Dev stack, project repo: stale `agent/task-*` worktrees/branches from the former worktree mode may exist (see the report) —
  ask the admin to propose a cleanup, or call the endpoint with `dryRun` first.
