# Implementation Reference — Local Dev Server

> Snapshot of the current implementation (v1 skeleton). This is a reference for
> how the system is built today, meant to be read alongside the code. For planned
> work see [`rfc-001-channels-and-human-agents.md`](./rfc-001-channels-and-human-agents.md)
> (channels/human-agents) and [`roadmap.md`](./roadmap.md) (staged build-out, in Russian).
> Every module described in §3/§6.4 also has a second, dual implementation for the
> `minimal`/single-container deploy profile — see §13 and
> [`plan-single-container.md`](./plan-single-container.md).
>
> Path references use `file:line` against `apps/`, `packages/`, `infra/`, `agent/`.

---

## 1. What it is

A self-hosted **orchestration platform** that runs a fleet of Claude Code agents for
autonomous development. It is the *control plane* around the agents, not the app they
write. Two pillars:

- **Orchestrator** (`apps/orchestrator`) — NestJS REST API + Socket.IO gateway. Owns the
  task lifecycle, spawns/supervises agents, routes each run to a model endpoint, and gates
  dangerous tool calls behind human approval.
- **Dashboard** (`apps/dashboard`) — Next.js (App Router) + CSS Modules. Human ↔ agent
  chat, live logs, approvals, and management of providers / agents / MCP servers / settings.

Shared logic lives in two packages: **`@lds/shared`** (domain types, event names, the danger
classifier, provider→env resolution) and **`@lds/agent-runner`** (drives the Claude Agent SDK).

> **Status:** v1 skeleton. **No auth/RBAC, no multi-tenancy** — every dashboard user and every
> hook caller (bar the shared hook secret) is trusted. Production hardening is out of scope for v1.

---

## 2. Repository layout

```
local-dev-server/
├── apps/
│   ├── orchestrator/        NestJS API + WebSocket gateway + BullMQ worker
│   └── dashboard/           Next.js UI (App Router)
├── packages/
│   ├── shared/              @lds/shared — types, events, classifier, routing
│   └── agent-runner/        @lds/agent-runner — runAgent() over the Claude Agent SDK
├── agent/                   Fleet operational files (bind-mounted at /workspace/agent)
│   ├── SOUL.md              Global charter, prepended to every run
│   ├── agents/*.md          Named agent definitions (frontmatter + system prompt)
│   ├── skills/*.md          Reusable knowledge, folded into the system prompt
│   └── runs/<taskId>/       Generated Claude Code settings.json (gitignored)
├── project/                 The workspace repo agents work in (/workspace/repo)
├── infra/                   Dockerfile, entrypoints, litellm config, approval hook, pg init
├── docker-compose.yml       Full stack
├── turbo.json               Build pipeline + globalEnv allowlist
└── pnpm-workspace.yaml       apps/* + packages/*
```

Tooling: **pnpm 10.33** workspaces, **turbo** pipeline (`build`/`dev`/`lint`/`typecheck`,
each `dependsOn: ["^build"]`), TypeScript strict (`tsconfig.base.json`: NodeNext, ES2022,
`noUncheckedIndexedAccess`).

---

## 3. Runtime topology (docker-compose)

| Service | Image | Port | Role |
|---|---|---|---|
| **postgres** | `postgres:16-alpine` | 5432 | Two DBs: `orchestrator` + `litellm` (separate — see gotcha) |
| **redis** | `redis:7-alpine` | 6379 | BullMQ backend (`--appendonly yes`) |
| **litellm** | `ghcr.io/berriai/litellm:main-stable` | 4000 | Anthropic-protocol proxy in front of all model backends |
| **orchestrator** | built from `infra/dev.Dockerfile` | 3001 | REST + WS + worker |
| **dashboard** | built from `infra/dev.Dockerfile` | 3000 | Next.js UI (no secrets passed in) |
| **playwright-mcp** | `mcr.microsoft.com/playwright/mcp` | 8931 | Optional browser MCP, `profiles: [mcp]` |

**Ollama runs on the HOST**, not in compose — containers reach it at
`http://host.docker.internal:11434`.

**Bind-mounts / volumes:** `./project → /workspace/repo` (project files only),
`./agent → /workspace/agent` (fleet ops files), `worktrees` volume → per-task git worktrees,
`pgdata`, `redisdata`, `pnpm-store`. The single `infra/dev.Dockerfile` (Node 22 + pnpm + `uv`/`uvx`
for Serena) serves both app services; their entrypoints are bind-mounted so editing them needs
no rebuild.

**Entrypoints** (`infra/*-entrypoint.sh`): both run `pnpm install --frozen-lockfile` then
`turbo run dev`. The **orchestrator** entrypoint additionally runs `prisma generate` +
`prisma migrate deploy` before starting (so the generated client lands in the bind-mount).

**Gotchas** (learned operationally):
- **LiteLLM MUST own its own `litellm` database.** On boot it runs a destructive prisma sync
  that drops every table in its DB — sharing `orchestrator` once wiped all orchestrator tables.
  `infra/postgres-init/01-create-litellm-db.sql` creates it on a fresh volume.
- **EADDRINUSE :3001** — `nest --watch` can keep a stale process on the port; recover with
  `docker compose restart orchestrator`.
- Local models need **structured tool-use**: Qwopus emits `tool_calls`; `qwen2.5-coder` returns
  them as plain text and breaks the SDK.

---

## 4. Data model (Prisma — `apps/orchestrator/prisma/schema.prisma`)

```
AppSettings (singleton "singleton")   — runtime config, seeded from env, DB is source of truth
McpServer   (name unique, config Json) — an MCP server agents can attach
Provider    (name unique)              — an AI model endpoint (Anthropic/OpenAI/DeepSeek/Ollama)
Task        (cuid)                     — a unit of work
 └─ AgentSession (per run/attempt)     — provider+model+claudeSessionId for --resume
     └─ AgentEvent (seq, kind, text)   — persisted transcript line (+attachments[])
 └─ ApprovalRequest                    — a gated dangerous tool call
```

Enums: `TaskStatus = queued | running | needs_approval | done | failed | cancelled`;
`AgentSessionStatus = starting | running | completed | errored | cancelled`;
`ApprovalStatus = pending | approved | denied | timeout`.

Notable fields:
- **Task**: `prompt`, `title`, `status`, `branch`, `worktreePath`, `agentName`, `prUrl`, `error`.
- **AgentSession**: `provider`, `model`, `claudeSessionId` (captured from the SDK init event, used
  to `--resume` on follow-ups).
- **AgentEvent**: `seq` (monotonic per session), `kind` (`prompt|system|assistant|tool_use|
  delegation|tool_result|result|stderr`), `text`, `attachments[]` (filenames, for inline thumbnails).
- **ApprovalRequest**: `toolName`, `toolInput` (Json), `summary`, `reason`, `status`, `resolvedBy`.

There is **no message/chat table** and **no User table**: human↔agent conversation *is* the
Task's `prompt` + follow-ups, persisted as `AgentEvent` rows. Identity is at best a free-form
`resolvedBy` string on approvals.

---

## 5. The task lifecycle (end to end)

```
POST /api/tasks ──▶ TasksService.create ──▶ TaskQueueService.enqueue (BullMQ)
                         │                          │
                    task-upserted               (deferred if attachments upload first → /start)
                         ▼                          ▼
                                        TaskWorkerService.process
                                          status → running
                                          worktree: create agent/task-<id>  (or reuse on follow-up)
                                          RealAgentExecutor.run(...)
                                            resolve provider+model → LiteLLM route → modelEnv
                                            build subagents (all other agents), MCP map, attachments
                                            runAgent(...) from @lds/agent-runner
                                              stream AgentEvent → bus (live) + DB (ordered)
                                              PreToolUse hook on every tool call ──┐
                                          verify gate: run verifyCommands           │
                                            fail → hand output back, retry ≤ N       │
                                          status → done | failed | cancelled         │
                                          on done + repo mode: push branch, open PR  │
                                                                                     ▼
                          ApprovalsService.check → classify → dangerous?  create ApprovalRequest,
                          task → needs_approval; hook long-polls /wait until decision or timeout
```

- **create** (`tasks.service.ts:48`): resolves the agent (explicit `agentName` 404s on a bad name;
  otherwise the configured `defaultAgent`, default `pm`), derives a title, persists the task,
  publishes `task-upserted`, and enqueues — unless `autostart=false` (client uploads attachments,
  then calls `POST /tasks/:id/start`).
- **follow-up** (`tasks.service.ts:84`): allowed **only on a terminal task** (else a duplicate job
  would race the same worktree); re-queues with `followUpPrompt`, which resumes the last *completed*
  Claude session.
- **worker** (`queue/task-worker.service.ts`): BullMQ worker, concurrency = `AGENT_CONCURRENCY`
  (default 2), **no retries** (`attempts: 1` — agent runs aren't idempotent). Follow-ups reuse the
  existing branch + worktree; first runs create `agent/task-<id>`.
- **verification gate** (`queue/verification.service.ts` + `verifyWithFixes`): after a run,
  runs each line of `verifyCommands` in the worktree; on failure hands the output back to the
  executor for up to `verifyMaxAttempts` fix iterations (default 2; `0` = fail without auto-fix).
  Only a green run is marked `done`/pushed.

---

## 6. Orchestrator modules (`apps/orchestrator/src`)

Bootstrap (`main.ts`): global prefix `/api`, CORS from `config/cors.ts`, global `ValidationPipe`
(`whitelist`, `transform`, `forbidNonWhitelisted`), shutdown hooks. `app.module.ts` wires all
modules; `ConfigModule` is global.

| Module | Responsibility | Key entry points |
|---|---|---|
| **tasks** | Task CRUD + lifecycle transitions | `tasks.service.ts` create/followUp/start/cancel/delete/setStatus |
| **queue** | BullMQ producer + worker + verify gate | `task-queue.service.ts`, `task-worker.service.ts:process`, `verification.service.ts` |
| **agent** | Executor abstraction | `agent-executor.ts` (abstract), `real-agent-executor.ts`, `stub-agent-executor.ts`; DI binds `AgentExecutor → RealAgentExecutor` |
| **agent-registry** | File-based named agents | `agent-registry.service.ts` parse/list/get/save/remove `agent/agents/<name>.md` |
| **approvals** | Danger gate + hook API | `approvals.service.ts` check/waitForVerdict/decide/timeout/resumeTaskIfClear; `hook-secret.guard.ts` |
| **providers** | Model-endpoint CRUD + tests | `providers.service.ts` CRUD, `test` ("whoami"), `listModels`, LiteLLM route sync |
| **litellm** | LiteLLM admin-API client | `litellm.service.ts` ensureRoute/registerRoute/deleteRoutesFor/listRoutes |
| **mcp** | MCP server registry + resolution | `mcp.service.ts` resolveMany + `${SECRET}` substitution; seeds playwright/github/postgres/code-intel |
| **attachments** | Per-task file upload/serve | `attachments.service.ts` save/list/paths/dir/remove (images+PDF, 10 MB) |
| **worktrees** | Workspace + per-task git worktrees + PR | `workspace.service.ts` ensure/provision/baseRef; `worktree.service.ts` createForTask/cleanup; `github.service.ts` publishResult |
| **settings** | Singleton runtime config | `settings.service.ts` accessors; secret-masked API |
| **bus** | In-process pub/sub | `agent-event-bus.ts` publish/subscribe |
| **events** | Socket.IO gateway | `events.gateway.ts` bus → rooms |
| **config** | Typed env access | `app-config.service.ts` |
| **health** | `GET /api/health` | container readiness |

### 6.1 Event bus & gateway

`AgentEventBus` (`bus/agent-event-bus.ts`) is a single-channel Node `EventEmitter`
(`setMaxListeners(0)`). Producers: executor (`agent-log`, `agent-status`), tasks
(`task-status`, `task-upserted`, `task-deleted`), approvals (`approval-created`,
`approval-resolved`). Consumers: the **gateway** and the **approvals service itself**
(`waitForVerdict` subscribes for `approval-resolved`). It is **in-process only** — no
persistence, synchronous emit, latecomers miss history.

`EventsGateway` (`events/events.gateway.ts`) bridges the bus to Socket.IO rooms:
`global` (task list + all approvals) and `task:<id>` (per-task live log). Clients auto-join
`global`; they `subscribe:task` / `unsubscribe:task` for a specific task. Event names live in
`@lds/shared` (`SERVER_EVENT`, `CLIENT_EVENT`, `ROOM`).

### 6.2 Agent executor (`agent/real-agent-executor.ts`)

The heart of a run. `run(ctx)`:

1. Resolve **provider**: `agentDef?.provider ?? settings.defaultProvider`; **model**:
   `agentDef?.model || provider.model` (else throws). (`real-agent-executor.ts:52-68`)
2. `resolveModelEnv` (`:253`): if `LITELLM_MASTER_KEY` is set, `litellm.ensureRoute(provider, model)`
   and point the agent at LiteLLM with the master key (`ANTHROPIC_MODEL = <provider>/<model>`,
   `ANTHROPIC_BASE_URL = litellm`, `ANTHROPIC_AUTH_TOKEN = masterKey`). Otherwise call
   `resolveProvider()` directly (Anthropic-protocol endpoints only).
3. Build **MCP** map from `agentDef.mcp` (injecting `GITHUB_TOKEN`), gather **attachment** paths,
   build **subagents** = every registered agent except the lead (`buildSubagents:283`), each on its
   own LiteLLM route.
4. On a follow-up, find the last **completed** session's `claudeSessionId` to `--resume`
   (errored/aborted sessions have no saved transcript → fresh run). (`:100`)
5. Create an `AgentSession`, wire the **hook**, record the user's message as a `prompt` event, then
   `runAgent(...)`. Every SDK event is published to the bus immediately and persisted via a serial
   `writeChain` (ordered). A hard timeout (`AGENT_RUN_TIMEOUT_MS`, default 10 min) aborts the run.
6. `buildInstructions` (`:329`) assembles the system-prompt append **top→bottom**: global
   `agent/SOUL.md` → project `<repo>/SOUL.md` → agent body (or the DB `agentInstructions`) → skill
   files (per-file cap 16 KB, total 64 KB).

Note: **`SendMessage` is always disallowed** for the lead (`:195`) — delegation goes through the
built-in **Task tool**, since subagents are spawned per-delegation, not persistently addressable.

### 6.3 Approval gate (`approvals/`)

- **check** (`approvals.service.ts:56`): runs `classifyToolCall()` from `@lds/shared`. Benign →
  allow inline. Dangerous → create a pending `ApprovalRequest`, flip task → `needs_approval`,
  publish `approval-created`, return an `approvalId`.
- **waitForVerdict** (`:88`): long-poll. Subscribe to the bus for the matching `approval-resolved`,
  re-check the DB (covers the race where the verdict lands first), and on the deadline call
  `timeout()` (→ status `timeout`, treated as **deny**). The controller clamps the client window to
  `[1s, 1h]`.
- **decide** (`:130`): human verdict → `approved|denied`, publish, then `resumeTaskIfClear` (`:187`)
  flips `needs_approval → running` via an atomic `updateMany` guarded on the current status (so a
  cancelled task isn't resurrected).
- **hook-secret.guard.ts**: `/approvals/check` and `/:id/wait` require the `x-lds-hook-secret`
  header to match `config.hookSecret` — a local rogue process can't forge approvals.

### 6.4 Model routing: providers + LiteLLM

Routing is **provider-based** (the old tier system is fully removed). A `Provider` is
`{name, kind, baseUrl, model, authMode, secret}` where `kind ∈ anthropic|openai|deepseek|ollama`.
Seeded on first boot from env: `ollama-local` (kind ollama, host Ollama) and `claude-cloud`
(kind anthropic, native API).

**Everything flows through LiteLLM when a master key is configured.** For each `(provider, model)`
pair the orchestrator ensures an exact route `<provider>/<model>` in LiteLLM's admin API
(`litellm.service.ts` `ensureRoute`/`registerRoute`), mapping `kind →` backend prefix
(`anthropic`→`anthropic` keep-reasoning; `openai`/`deepseek`→drop reasoning params;
`ollama`→`ollama_chat`). The agent always talks **Anthropic protocol** to LiteLLM with the master
key; LiteLLM forwards to the real upstream with the provider's key (`STORE_MODEL_IN_DB`, keys never
reach the browser or the agent). Routes are re-synced on provider CRUD and on boot
(`providers.service.ts` `onModuleInit`). Provider secrets are masked in API responses
(`secretSet` + last-4 hint). A **connectivity test** (`test`) sends a minimal "reply with your
model name" request and reports latency/model/error.

`infra/litellm-config.yaml` additionally defines a static `local-coder` route (Qwopus 27B via
`ollama_chat/`) and a `"*"` wildcard to host Ollama; `drop_params: true`, `request_timeout: 600`.

**`authMode: 'oauth-token'`** — a third mode alongside `api-key`/`auth-token`: a CLI-minted
subscription token (e.g. `claude setup-token`, or `scripts/cli-auth.sh <provider-name>` which
wraps it and registers the result). Unlike the other two modes, this **always bypasses LiteLLM**
— LiteLLM can only forward with a real Anthropic `x-api-key`, so `resolveModelEnv`
(`real-agent-executor.ts`) short-circuits to `CLAUDE_CODE_OAUTH_TOKEN` + `ANTHROPIC_MODEL` and
talks to Anthropic's native endpoint directly, ignoring `baseUrl` and never calling `ensureRoute`.
`resolveProvider()` (`@lds/shared`) looks up the env var name per `provider.kind` via a small
table (`OAUTH_ENV_VAR_BY_KIND`) — the extension point for a future CLI-login provider on a
different `kind`. Known v1 limitation: since the SDK shares one connection (base URL + auth)
between the lead and all its subagents, a task whose default provider is `oauth-token` gets **no
delegatable subagents** (`buildSubagents` returns empty), and any individual subagent whose own
provider is `oauth-token` is skipped the same way — mixing an oauth-token connection with
LiteLLM-routed subagents in one run isn't supported. The connectivity `test()` also short-circuits
for this mode (returns a friendly "not verified via HTTP probe" result) rather than guessing at
the token's actual request shape; run a real task to confirm it works. Multiple providers can use
different auth modes side by side (e.g. one `api-key` and one `oauth-token` provider both
registered) — the mode lives on the `Provider` row, not globally.

**Token lifetime & rotation**: a `claude setup-token` token is a static bearer credential that
expires after 1 year, with no documented auto-refresh — an operator rotates it by re-running
`claude setup-token` (via `scripts/cli-auth.sh <name>` or `infra/setup-wizard.mjs`'s "rotate an
existing provider's secret" step, or the dashboard) against the **same** provider name, which
`PUT`s the existing row rather than creating a duplicate. Neither the CLI helper nor the wizard
attempt to auto-capture the printed token by piping `claude setup-token`'s output — that hides
the interactive login URL from the operator and deadlocks the process waiting for a browser
confirmation it was never shown; both always run it with fully inherited stdio and prompt for a
manual paste afterward.

### 6.5 Worktrees & GitHub

`WorkspaceService.ensure()` (serialized by a promise lock) provisions `/workspace/repo`: if
`repoUrl` is set it clones/fetches (token injected via `GIT_CONFIG_*` env, never on disk/argv);
if empty it `git init`s with an empty commit. `WorktreeService.createForTask` adds
`agent/task-<id>` at a worktree based on `origin/<branch>` (repo mode) or `HEAD` (local). On a
successful repo-mode run, `GitHubService.publishResult` force-with-lease pushes and opens (or
finds) a PR — best-effort; failure never fails the task. This is the **only outbound integration
today**.

### 6.6 MCP & attachments

MCP configs are raw SDK `McpServerConfig` JSON stored in `McpServer`. `resolveMany(names, secrets)`
builds the `{name: config}` map and recursively substitutes `${KEY}` (e.g. `${GITHUB_TOKEN}`);
unknown names are skipped with a warning (non-blocking) — but this only catches "no such server in
the DB," not "the server's underlying binary (`uvx`/`npx`) isn't actually on `PATH`"; that surfaces
later as an SDK spawn/connection failure at task-run time, not a clean upfront warning. Seeded
servers: `playwright` (sse), `github` (http, needs token), `postgres` (npx stdio), `code-intel` =
Serena (uvx stdio). Of the 11 bundled skills, only `code-intel` and `playwright` actually call an
`mcp__` tool (everything else is pure Bash/knowledge — `git`'s GitHub-operations subsection
degrades gracefully by design if `github` isn't in an agent's `mcp:` list). `uv`/`uvx` is installed
to `/usr/local/bin` in the full dev image, the minimal Docker image, and (best-effort,
non-fatal) bare-metal installs (`install.sh`'s `ensure_uv`) — so `code-intel` works in all three.
`playwright` still needs a running browser MCP service, which only the full profile's
`--profile mcp` compose service provides; bare-metal/minimal have no equivalent yet (tracked in
`docs/BACKLOG.md`). Attachments are per-task files (`png/jpg/jpeg/webp/gif/pdf`, ≤10 MB) streamed
to `<attachmentsDir>/<taskId>/`, surfaced to the agent as prompt paths (read via the Read tool) and
to the UI as inline thumbnails.

### 6.7 Settings (`settings/settings.service.ts`)

Singleton row `id="singleton"`, seeded from env on first load, DB authoritative thereafter (no
restart needed). Accessors: `approvalTimeoutSeconds`, `verifyCommands` (split per line),
`verifyMaxAttempts`, `agentInstructions`, `defaultProvider`, `defaultAgent` (default `pm`, used by
`tasks.create`), `workspaceConfig` (`{repoUrl, repoBranch, githubToken}`). `githubToken` is masked
in the API (set-flag + last-4). Empty-string in the update DTO clears a nullable field; `undefined`
leaves it.

---

## 7. `@lds/agent-runner`

Drives one headless Claude Code session via the Claude Agent SDK. Files: `run.ts` (`runAgent`),
`types.ts`, `settings.ts` (`writeAgentSettings`), `env.ts` (`buildAgentEnv`), `index.ts`.

**`runAgent(params, onEvent)`** (`run.ts`):
1. `buildAgentEnv` — a strict **allowlist** env (PATH/HOME/locale/proxy only) plus the model vars
   (`ANTHROPIC_MODEL` + `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`/`API_KEY`), hook context
   (`LDS_*`), and `LDS_SKILLS_DIR`/`LDS_ATTACHMENTS_DIR`. The agent **never** sees
   `DATABASE_URL`/`REDIS_URL`/`GITHUB_TOKEN`/host identity — `printenv` can't exfiltrate secrets.
   `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS=1` hides Claude Code's built-in subagents (team-only
   delegation).
2. `writeAgentSettings` — generates `settings.json` (into `settingsDir`, i.e. `agent/runs/<taskId>`
   so the worktree stays clean) wiring the **PreToolUse** hook: `node <scriptPath>`, matcher `*`,
   timeout `approvalTimeoutSeconds + 15`.
3. Dynamically imports the ESM SDK and calls `query()` with `cwd`, `env`, `maxTurns`,
   `resume`, `appendSystemPrompt`, `allowedTools`/`disallowedTools`, `mcpServers`, `agents`
   (subagents), `settings`, `settingSources: []` (isolate from host), `permissionMode: 'default'`
   (defer to the hook), `abortController`.
4. Maps SDK stream messages → `AgentEvent` (`prompt|system|assistant|tool_use|delegation|
   tool_result|result|stderr`); `Task`/`Agent` tool calls become `delegation` events.

**`SubagentDefinition`** = `{description, prompt, model?, tools?}`; `model` is the subagent's
LiteLLM route so it runs on its own provider.

**`HookWiring`** = `{scriptPath, approvalsUrl, approvalTimeoutSeconds, secret, taskId,
agentSessionId, sharedDistPath}`.

**The hook** (`infra/hooks/pre-tool-use.mjs`): reads the tool call on stdin, runs the local
`classifyToolCall` from `LDS_SHARED_DIST` (**zero-latency allow** for benign calls), else POSTs
`/api/approvals/check` (with `x-lds-hook-secret`); if an approval is opened, GETs
`/api/approvals/:id/wait` and blocks. **Fail-closed**: any missing wiring / network error /
timeout → `permissionDecision: 'deny'`. Always exits 0 with the SDK's JSON decision contract.

---

## 8. `@lds/shared`

Files: `types.ts`, `events.ts`, `routing.ts`, `classify.ts`, `dto.ts`, `index.ts`.

- **types.ts** — `Task`, `TaskStatus`, `TERMINAL_TASK_STATUSES` + `isTerminalStatus()`,
  `AgentSession`, `ApprovalRequest` (wire shapes, dates as ISO strings).
- **events.ts** — `ROOM` (`global`, `task(id)`), `SERVER_EVENT` (`task:upserted|status|deleted`,
  `agent:log|status`, `approval:created|resolved`), `CLIENT_EVENT` (`subscribe:task`,
  `unsubscribe:task`), and the payload types (`AgentLogEvent`, `TaskStatusEvent`, …).
- **routing.ts** — `Provider`, `AgentModelEnv`, `resolveProvider(provider) → AgentModelEnv`
  (api-key → `ANTHROPIC_API_KEY`; auth-token → `ANTHROPIC_AUTH_TOKEN`), `ProviderError`.
- **classify.ts** — `classifyToolCall(toolName, toolInput, {workspaceRoot?}) → {dangerous,
  summary, reason}`. **Single source of truth**, run by both the hook (fast path) and the
  orchestrator. Rules: any `mcp__*` tool → dangerous; shell commands matched against a pattern set
  (`rm -rf`, `git push`, `--force`, `git reset --hard`/`clean`, `*publish`, `docker push`,
  `terraform/kubectl` mutations, outbound `curl/wget -d`, `nc/socat`, `/dev/tcp`, inline
  interpreter network/exec, `sudo`, `chmod 777`, `mkfs`/`dd`, raw block devices, `shutdown/reboot`,
  fork bomb, `kill -9`); file writes outside `workspaceRoot` or to protected paths
  (`SOUL.md`, `.github/`, `.git/`, `.lds/`) → dangerous; everything else auto-allowed.
- **dto.ts** — REST DTO shapes incl. `HookCheckInput`/`HookCheckResponse`.

---

## 9. The fleet (`agent/`)

**SOUL.md** — the charter prepended to *every* run, above role and skills. Principles:
understand before you change; stay in scope; be honest; work safely (stay in your worktree,
destructive/outbound actions go through the gate); verify; leave a clear trail. It also documents
delegation ("route by capability, not keyword"; use the **Task tool**, not `SendMessage`), skills
(read freely; writing to `agent/skills/` is approval-gated — how the fleet *learns*), and
attachments (`$LDS_ATTACHMENTS_DIR`).

**Agents** (`agent/agents/<name>.md`, frontmatter + body = system prompt; read on demand, no
restart):

| Agent | Provider (default) | Notable frontmatter | Role |
|---|---|---|---|
| **pm** | claude-cloud | `skills: translation`, `disallowedTools: Write,Edit,NotebookEdit` | Default lead: clarify, plan, delegate. Read-only. |
| **architect** | claude-cloud | `model: claude-sonnet-4-5` | System design, trade-offs, plans. |
| **backend** | DeepSeek | `mcp: postgres,github,code-intel` | Server/API/DB implementation. |
| **frontend** | DeepSeek | `mcp: playwright,code-intel,github` | Client/UI implementation. |
| **designer** | GPT | — | UX/visual design, image analysis. |
| **coder** | DeepSeek | `mcp: github,postgres,code-intel` | General implementation fallback. |
| **reviewer** | claude-cloud | `model: claude-haiku-4-5`, read-only | Code review / audit. |
| **local-helper** | ollama-local | — | Tiny low-risk edits on the local model. |

The task's agent is the **lead**; all *other* agents are offered as delegatable subagents. A task
with no agent falls back to `defaultAgent` (`pm`).

**Skills** (`agent/skills/*.md`) — folded into the system prompt. Two directories, different
trust levels (roadmap Phase 6, done):
- `core/` — human/Architect-authored, an agent picks the subset it declares in frontmatter.
  Ships `translation.md` (RU↔EN bridge: detect the human's language, work/commit/delegate in
  English, translate results back).
- `learned/` — agent-authored observations, always loaded (no opt-in needed), but writes are
  gated: an agent proposes a write via the `propose_learned_skill` tool (the ONE internal tool
  NOT exempt from the approval gate — `classify.ts`), which enforces a 16KB/file + 64KB/total
  budget and snapshots the current version to `.snapshots/` before any overwrite (one-command
  rollback). `SkillConsolidationSchedulerService` periodically (default every 7 days) schedules
  a *separate* review task to consolidate `learned/*` via the same tool — never something an
  agent does to its own output inside the turn that produced it (self-consolidation bias).
  Promoting a learned observation into `core/` is a human decision (normal reviewed file edit;
  no tool path writes there). See `agent/skills/learned/README.md` for the full policy.
`README.md` is excluded from both directories when building the prompt.

---

## 10. Dashboard (`apps/dashboard`)

Next.js App Router, CSS Modules (no Tailwind), design tokens in `globals.css`. No external state
library — React hooks + a Socket.IO singleton.

**Routes** (`src/app`):
- `/` — task fleet: create form, task list, pending approvals, connection status.
- `/tasks/[id]` — chat-style detail: live transcript, attachments gallery, approval cards,
  follow-up composer. De-dups live vs fetched lines by `sessionId:seq`.
- `/agents` — agent CRUD with provider/model/skills/MCP pickers and model preview.
- `/settings` — tabbed: General (repo/token/timeouts/verify/defaults), Providers (CRUD + test),
  LiteLLM (read-only routes), MCP servers (CRUD).

**Client libs** (`src/lib`): `config.ts` (`NEXT_PUBLIC_ORCHESTRATOR_URL` /
`_WS_URL`, default `http://localhost:3001`), `api.ts` (typed `fetch` wrapper `unwrap<T>` +
every REST endpoint), `socket.ts` (lazy `io()` singleton; subscribes to the `SERVER_EVENT`s and
calls refetch/append on each). `next.config.mjs` transpiles `@lds/shared`. The dashboard container
gets **no secrets** — only `NEXT_PUBLIC_*` reach the browser.

---

## 11. Configuration & key defaults

Env is grouped in `.env.example` and allowlisted in `turbo.json` `globalEnv`. Notable
(`config/app-config.service.ts` holds the typed getters + defaults):

| Var | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | — (required) | orchestrator Postgres |
| `REDIS_URL` | redis://redis:6379 | BullMQ backend |
| `ORCHESTRATOR_PORT` / `DASHBOARD_PORT` | 3001 / 3000 | host ports |
| `NEXT_PUBLIC_ORCHESTRATOR_URL` / `_WS_URL` | http://localhost:3001 | browser → API/WS |
| `LITELLM_BASE_URL` / `LITELLM_MASTER_KEY` | http://litellm:4000 / — | proxy URL + master key (gates all LiteLLM traffic) |
| `OLLAMA_BASE_URL` / `ROUTINE_MODEL` | host.docker.internal:11434 / — | local tier |
| `ANTHROPIC_API_KEY` / `COMPLEX_MODEL` | — / claude-sonnet-4-6 | cloud tier |
| `WORKSPACE_REPO_PATH` / `AGENT_DIR` / `WORKTREES_ROOT` | /workspace/repo · /workspace/agent · volume | paths |
| `AGENT_CONCURRENCY` / `AGENT_MAX_TURNS` / `AGENT_RUN_TIMEOUT_MS` | 2 / 40 / 600000 | run bounds |
| `APPROVALS_API_URL` / `APPROVAL_TIMEOUT_SECONDS` | http://orchestrator:3001 / 300 | hook callback + gate timeout |
| `LDS_HOOK_SECRET` | randomUUID() | hook ↔ orchestrator shared secret |
| `HOOK_SCRIPT_PATH` / `SHARED_DIST_PATH` | infra hook / resolved | hook wiring |
| `REPO_URL` / `REPO_BRANCH` / `GITHUB_TOKEN` | — / main / — | workspace source + PR auth |

`verifyMaxAttempts` default 2 (schema), skills caps 16 KB/file & 64 KB total, attachments ≤10 MB.

**Makefile**: `up` (build+start), `down`, `logs`, `ps`, `build`, `migrate`, `pull-models`,
`clean` (destructive: `down -v`).

---

## 12. Known limitations (v1)

- **No auth / RBAC / multi-tenant.** The dashboard and hook callers are trusted (bar the hook
  secret). This is the biggest gap before exposing the system beyond a single operator.
- **No model/provider failover.** A missing/misconfigured provider or a runtime model error just
  fails the task — no fallback chain, no retry on another provider.
- **No task retries** at the queue level (`attempts: 1`) — agent runs aren't idempotent.
- **In-process event bus** — no persistence, single instance; not horizontally scalable as-is.
- **Only outbound integration is GitHub PRs.** External comms channels (Slack/Telegram) and human
  participants are proposed but not built — see
  [`rfc-001-channels-and-human-agents.md`](./rfc-001-channels-and-human-agents.md).

## 13. Deploy profiles: `full` vs `minimal`

Every stateful module the sections above describe (storage, queue, event bus, LiteLLM)
has a SECOND implementation, selected by env at boot — no separate codebase, no
feature-flag branching sprinkled through business logic. Full design/history:
[`plan-single-container.md`](./plan-single-container.md).

| Module | `full` (this doc, sections 3/6.4) | `minimal` | Selected by |
|---|---|---|---|
| Storage (`PrismaService` token) | Postgres | SQLite file (`prisma/sqlite/`, generated schema + own migrations) | `DATABASE_URL` scheme |
| Queue (`TaskQueue` token) | BullMQ + Redis | in-process poller over a `QueueJob` table | `REDIS_URL` presence |
| Event bus (`AgentEventBus` token) | Redis pub/sub | in-process `EventEmitter` | same signal as Queue |
| LiteLLM (`LitellmService`'s 3 write methods) | admin API (needs LiteLLM's own Postgres) | `LitellmManagedService`: a `child_process`-spawned litellm + a static rendered config | `LITELLM_MANAGED=1` |
| Dashboard | separate Next dev container | Next `standalone` build, same container | build target |

Each pair is bound to the SAME DI token via a factory provider (e.g.
`{ provide: PrismaService, useFactory: (config) => config.storageDriver === 'sqlite' ? new PrismaServiceSqlite() : new PrismaService() }`)
so the ~15-20 files across the app that inject `PrismaService`/`TaskQueue`/
`AgentEventBus` never change regardless of which profile is running.

`minimal` packaging (`infra/minimal.Dockerfile`, `infra/minimal-supervisor.mjs`) is
covered in the README's "Server deployment" section — one container running Node
(orchestrator + dashboard) and a `python3-venv` (litellm, spawned BY the orchestrator,
not a third top-level process). `full` remains the default and the regression baseline;
`minimal` is not a reduced feature set, just a different set of backing implementations
for the same modules.
</content>
