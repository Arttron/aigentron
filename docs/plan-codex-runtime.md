# Plan: Codex as an agent runtime (alongside Claude Code)

> Status: DRAFT (2026-10-07). Goal: agents can run on **OpenAI Codex** exactly like they run on Claude Code,
> including with a **ChatGPT subscription login**. LiteLLM stays the universal *model* layer; this is a second
> *agent runtime*, not another LiteLLM route.
> Facts about Codex below come from OpenAI's docs (non-interactive mode, SDK, MCP, hooks pages) and are marked
> **[verify]** where a spike must confirm them. **Phase R0 spike done 2026-10-07 against `codex-cli 0.160.1`:
> results in §6; unmarked rows below are now verified unless §6 says otherwise.**

## 1. What Codex offers that we can build on

| Need | Codex capability | Notes |
|---|---|---|
| Headless run | `codex exec --json` -> JSONL events (`thread.started`, `turn.started/completed/failed`, `item.*`: messages, reasoning, command execution, file changes, MCP calls, web search) | maps onto our `AgentEvent` stream |
| Resume / follow-up | `codex exec resume <SESSION_ID>`; SDK `startThread()/resumeThread()` | replaces `claudeSessionId` |
| Isolation | `--sandbox read-only / workspace-write / danger-full-access`, `--cd`, `--ephemeral`, `--ignore-user-config` | sandbox inside Docker may not work (bwrap/landlock) **[verify]** -> likely `danger-full-access` + our hooks, since the container is the sandbox |
| Auth | ChatGPT login (`codex login --device-auth`, tokens in `$CODEX_HOME/auth.json`) or `CODEX_API_KEY` | per-run `CODEX_HOME` lets us set config/hooks per task |
| MCP | `[mcp_servers.<name>]` in config.toml; **stdio and streamable HTTP**; `bearer_token_env_var`, headers; `enabled_tools`/`disabled_tools`; per-tool `approval_mode`; timeouts | **no SSE** mentioned -> our SSE servers (playwright-mcp) need an HTTP/stdio variant |
| Approval gate | Hooks (GA): `PreToolUse`, `PermissionRequest`, in `hooks.json` or `[hooks]` in config.toml | our hook script/endpoint can be adapted; input/output schema **[verify]** |
| Instructions | `AGENTS.md`, config instructions | how to inject SOUL + agent prompt + skills **[verify]** (fallback: write a per-run AGENTS.md / instructions file) |
| Programmatic API | TypeScript SDK `@openai/codex-sdk` (threads, `run`, sandbox presets) and CLI | start with the CLI (stable JSONL); SDK optional |

## 2. Design

### 2.1 Runtime abstraction
Today `RealAgentExecutor.attempt()` calls `runAgent()` (agent-runner, Claude Agent SDK) directly. Introduce:

```ts
interface AgentRuntime {
  id: 'claude-code' | 'codex';
  run(params: RuntimeParams, onEvent: AgentEventHandler): Promise<AgentRunResult>;
}
```
`claude-code` = the existing code, unchanged. `codex` = new. The runtime is **derived from the provider**:
a provider of kind `codex` runs on Codex; everything else on Claude Code (via LiteLLM as today).
Consequences: an agent picks Codex simply by `provider: chatgpt-sub`; the existing `fallbackProviders`
chain works **across runtimes** (e.g. Codex -> Claude) with no new concept.

### 2.2 Provider model
New `kind: 'codex'` with `authMode`:
- `codex-login` — ChatGPT subscription; no secret in the row; tokens live in a persistent `CODEX_HOME`
  volume (full: named volume; minimal/bare: under `/data/codex`). Status (signed in as…, expiry) shown in UI.
- `api-key` — `CODEX_API_KEY` stored like other provider secrets.
`model` = a Codex model name; model list is static/discovered via the CLI **[verify]**.

### 2.3 Auth flow (ChatGPT subscription)
Orchestrator spawns `codex login --device-auth` with the persistent `CODEX_HOME`, parses the verification URL
and user code from stdout, shows them in the provider form ("Sign in with ChatGPT"), polls until
`auth.json` appears, then reports "signed in". Per-run: create `runs/<task>/codex-home/`, copy/symlink
`auth.json` (writable — refresh tokens rotate; sync it back or point at the shared file with a lock),
write `config.toml` + hooks there. Never put tokens in agent env or logs.

### 2.4 Feature mapping (what must be rebuilt for Codex)

| Our feature (Claude Code today) | Codex plan |
|---|---|
| System prompt append (orientation, SOUL, agent body, skills) | per-run `AGENTS.md`/instructions file in `CODEX_HOME` or cwd overlay **[verify]** |
| In-process internal tools (`report_task_status`, `heartbeat`, `create_subtask`, `check_subtasks`, `schedule_check`, `propose_*`, admin tools) | serve them as an **HTTP MCP endpoint in the orchestrator** (`/api/mcp-internal`, per-run token bound to taskId/session) and register it in the run's config.toml. Same tool handlers; runtime-agnostic, and the existing `mcp-host` is a head start |
| PreToolUse approval hook + classifier | Codex `PreToolUse`/`PermissionRequest` hook calling the same `/api/approvals/check` + wait; adapt `infra/hooks/pre-tool-use.mjs` to Codex's payload **[verify]** |
| `allowedTools`/`disallowedTools` | coarse: sandbox mode + MCP `enabled_tools`/`disabled_tools`; shell/file tools can't be denied individually -> read-only agents use `--sandbox read-only` |
| MCP registry (`McpServer` rows) | render to `[mcp_servers.*]`; SSE servers unsupported -> need stdio/HTTP form or an adapter |
| Subagents via the SDK `Task` tool | not available; delegation uses our orchestrator-level `create_subtask` (already runtime-agnostic) |
| Resume by `claudeSessionId` | store the Codex thread/session id in the same `AgentSession.claudeSessionId` column (rename later) |
| Usage/cost stats | map token usage from `turn.completed` **[verify]**; cost via price table (subscription = no per-token cost: record tokens, cost 0) |
| Abort / timeout | kill the process group; keep `AGENT_RUN_TIMEOUT_MS` |
| Step limit (`maxTurns`) | no direct flag **[verify]** -> rely on timeout + turn counting from events |
| Attachments/images | `-i`/image input **[verify]**; files by path as today |
| Failover detection (`isFailoverWorthy`) | classify Codex errors (auth expired, rate limit/usage cap, model unavailable) |

### 2.5 Install
Codex binary (`npm i -g @openai/codex`) added to `dev.Dockerfile`, `minimal.Dockerfile` and the bare-metal
installer (Node 22 is already there); version pinned. Optional: skip when no codex provider is configured.

## 3. Risks

- **Unverified contracts:** hook payload, instructions injection, sandbox in Docker, usage fields — a spike
  must settle these before building (Phase R0).
- **Subscription limits:** ChatGPT plans have usage caps; unattended multi-task fleets can hit them -> failover
  to another provider is essential, and errors must be distinguishable.
- **Token handling:** `auth.json` refresh/rotation with concurrent runs (race) — serialize refresh or share one
  file with a lock.
- **Feature parity gap:** no Task-tool subagents, coarser tool permissions, no SSE MCP. Document it per runtime.
- **Terms of use:** automated use of a ChatGPT subscription through the official CLI is the supported path, but
  re-check OpenAI's current terms/limits before shipping it as a headline feature.
- **Churn:** Codex CLI changes fast; pin the version and keep the event mapper tolerant to unknown events.

## 4. Phases

- **R0 — spike (1–2 days, needs your ChatGPT sign-in).** In the orchestrator container: install Codex,
  `codex login --device-auth`, run `codex exec --json` with a per-run `CODEX_HOME`; confirm event shapes,
  hook payload/response, HTTP MCP tool call, AGENTS.md/instructions injection, sandbox behavior in Docker,
  resume. Output: a short verified-facts appendix replacing every **[verify]**.
- **R1 — runtime abstraction.** Extract `AgentRuntime`, move the Claude code behind it, no behavior change.
- **R2 — internal MCP over HTTP.** Orchestrator endpoint exposing the internal tools with per-run tokens
  (reused by Codex now, optionally by Claude later).
- **R3 — Codex runtime + provider kind `codex`.** Event mapper, hooks adapter, per-run `CODEX_HOME`,
  failover classification, usage.
- **R4 — auth UX.** Device-code login in the provider form, signed-in status, sign-out; API-key mode.
- **R5 — packaging and docs.** Install in all profiles, parity table in the docs, release.

## 5. Open decisions

1. Runtime selection: derived from provider kind (proposed) vs. an explicit `runtime:` field on the agent.
2. CLI (`codex exec --json`, proposed) vs. the TypeScript SDK for the first implementation.
3. Sandbox policy inside our container: trust the container (`danger-full-access` + hooks) vs. Codex's own sandbox if it works.
4. Where the ChatGPT login lives: one shared `CODEX_HOME` for the instance (proposed) vs. per-user.

## 6. Spike R0 results (codex-cli 0.160.1, ChatGPT subscription login, inside the orchestrator container)

**Works as planned**
- **Headless + JSONL:** `codex exec --json …`. Events seen: `thread.started{thread_id}`, `turn.started`,
  `item.started/completed` with `item.type` = `agent_message{text}`, `command_execution{command,aggregated_output,exit_code,status}`,
  `mcp_tool_call{server,tool,arguments,result,error,status}`, `file_change{changes:[{path,kind}]}`, `error{message}`;
  `turn.completed{usage{input_tokens,cached_input_tokens,cache_write_input_tokens,output_tokens,reasoning_output_tokens}}`;
  `turn.failed{error{message}}` (e.g. 401 after 5 reconnect attempts when not signed in). Default subscription model: `gpt-6.1-sol`.
- **Subscription auth:** `codex login --device-auth` works in the container; token in `$CODEX_HOME/auth.json`
  (default `~/.codex`); `codex login status` -> "Logged in using ChatGPT". Copying `auth.json` into a fresh per-run
  `CODEX_HOME` is enough to run (also verified).
- **Hooks are Claude-compatible.** `PreToolUse` command hook gets `{session_id, turn_id, cwd, hook_event_name, model,
  permission_mode, tool_name, tool_input, tool_use_id, transcript_path}`; replying
  `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":…}}`
  blocks the call (the model sees "Command blocked by PreToolUse hook: …"). Tool names: shell = `Bash`
  (`tool_input.command`), file edits = **`apply_patch`** (`tool_input.command` holds the patch text:
  `*** Add File: /path …`), MCP = `mcp__<server>__<tool>` (same scheme as ours). Hooks come from `$CODEX_HOME/hooks.json`;
  non-managed hooks need `--dangerously-bypass-hook-trust` for `exec` (we write the hooks ourselves per run).
  -> `infra/hooks/pre-tool-use.mjs` + `classifyToolCall` can be reused with small additions (map `apply_patch` to the
  Write/Edit path rules; parse target paths from the patch).
- **MCP over HTTP:** `-c 'mcp_servers.lds.url="http://127.0.0.1:3001/api/mcp"' -c 'mcp_servers.lds.bearer_token_env_var="MCP_TOKEN"'`
  -> tool call executed (`list_agents`). A server that rejects auth is skipped silently (model just says the tool is unavailable) —
  the runtime must verify the server is reachable before the run. Our internal tools live under server name `lds_internal`,
  so hook names `mcp__lds_internal__*` already match the classifier's exemption prefix.
- **Instructions:** `AGENTS.md` in the cwd is picked up; a global `$CODEX_HOME/AGENTS.md` is picked up too (verified with marker
  strings). So per-run `CODEX_HOME/AGENTS.md` can carry orientation + SOUL + agent prompt + skills.
- **Resume:** `codex exec resume <thread_id> "<prompt>"` keeps context (verified). Sessions are stored under
  `$CODEX_HOME/sessions`, so the per-task `CODEX_HOME` must persist across follow-ups.
- Resume/exec flags available: `-c`, `-m`, `-i <image>`, `--output-schema`, `-o`, `--ephemeral`, `--ignore-user-config`,
  `--ignore-rules`, `--skip-git-repo-check`.

**Findings that change the plan**
- **Codex's own sandbox does not work in Docker** (`bwrap: No permissions to create a new namespace`) -> run with
  `--sandbox danger-full-access` and rely on our hook + the container boundary. Read-only agents must be enforced by
  the hook classifier (deny `apply_patch` and mutating `Bash`), not by `--sandbox read-only` (decision §5.3 resolved).
- **Do not put `CODEX_HOME` under `/tmp`** (warning: helper binaries refused); use `agent/runs/<taskId>/codex-home`.
- `exec` prints "Reading additional input from stdin..." — spawn with stdin closed/ignored and the prompt as an argument,
  or it can wait on stdin.
- Two spurious `item.completed{type:error}` events are emitted for `--dangerously-bypass-hook-trust`; the mapper must filter them.
- **Login in our container landed in `~/.codex`, not `CODEX_HOME`** unless `CODEX_HOME` is set in the exec env; the provider
  login flow must set it explicitly. Token copied to `agent/.codex-home/` (gitignored).

**Still unverified (do in R3)**: step limit (`maxTurns` equivalent), abort/kill behavior, `-i` image input, concurrent
token refresh with parallel runs, `PermissionRequest` hook (not needed when bypassing approvals), reasoning/web-search item
shapes, SSE MCP servers (docs list only stdio/HTTP), long-prompt limits for `AGENTS.md`.

## 7. Implementation status (2026-10-07) — R1–R3 done, R4–R5 pending

Implemented and verified end-to-end against the live stack (ChatGPT subscription, codex-cli 0.160.1):
- **R1 runtime abstraction:** `packages/agent-runner` — `AgentRuntime` (`runtime.ts`), `runtimeForProviderKind()`;
  Claude path unchanged (`runAgent`). Internal tool definitions extracted to `internal-tools.ts` (shared by both runtimes).
- **R2 internal MCP over HTTP:** `apps/orchestrator/src/internal-mcp` — `/api/internal-mcp`, stateless Streamable HTTP,
  per-run random bearer token that only reaches that run's handlers and dies with the run.
- **R3 Codex runtime:** `packages/agent-runner/src/codex.ts` (`codex exec --json`, per-run `CODEX_HOME` with
  config.toml/hooks.json/AGENTS.md, event mapper, usage, abort, auth refresh sync-back), provider kind `codex`
  (`authMode: codex-login | api-key`), `CodexService` (login status, shared auth home), `apply_patch` classification and
  allow/deny-list enforcement in the PreToolUse hook, `codex:`-tagged session ids (a session is only resumed by its own
  runtime), Codex skipped as a subagent target, dashboard provider form support, Codex installed in dev/minimal images.
- **Verified:** task on a codex provider -> `done` with `report_task_status` delivered over the internal MCP, tokens recorded;
  follow-up resumes the thread with context; `rm -rf` -> `needs_approval` via our hook/classifier, deny -> agent reports
  `blocked` and the command does not run; provider "Test" checks `codex login status`.

Known gaps / next:
- **R4 auth UX (deferred 2026-10-08 — to be built once for ALL subscription/OAuth providers, see docs/BACKLOG.md):** the ChatGPT login is still a manual `codex login --device-auth` on the server (CODEX_HOME = `agent/.codex-home`);
  the dashboard flow (show URL + code, poll, signed-in status, sign out) is not built.
- **R5:** bare-metal `install.sh` does not install Codex yet; parity table in README; MCP servers over SSE (e.g. playwright-mcp)
  are skipped with a warning on Codex; no `maxTurns` equivalent (only the run timeout); `-i` image input and parallel-run
  token refresh are unverified; subscription runs record tokens but `costUsd` = 0.
