# MCP entry point — drive the fleet from an external client

The orchestrator hosts an **MCP server** at `POST/GET/DELETE /api/mcp`
(Streamable HTTP transport). Any MCP client — Claude Desktop, Claude Code, or a
browser-based client — can connect to create tasks, track their status, follow
up, and cancel. It's a thin adapter over the existing task machinery: work
queued here runs on the same fleet and shows up in the dashboard and Telegram.

## Model

- **create_task** queues work and returns `{ id, status, resource, dashboardUrl }`.
- Runs are **asynchronous**. Two ways to learn the result:
  - **`wait_for_task(id)`** — a blocking tool that returns once the task settles
    (done/failed/blocked/…) or times out. This is the reliable path for
    **tool-only clients** (e.g. claude.ai) that don't act on push notifications.
  - **Push** — `notifications/resources/updated` for `task://<id>` over the
    session's SSE stream, for resource-aware clients (e.g. Claude Desktop). You
    are auto-subscribed to any task you create or fetch; on each change, re-read
    `task://<id>` for the new `status` / `summary` / `prUrl`.
- Because the fleet has none of your project's context, **put everything the
  task needs into `prompt`** (paste the relevant docs/discussion). Attaching
  files/rich references is a later iteration.

## Tools

| Tool          | Args                                             | Returns |
|---------------|--------------------------------------------------|---------|
| `ping`        | —                                                | instant liveness (no queue/DB) |
| `help`        | —                                                | usage guide (the create→wait→follow_up/approve loop) |
| `list_agents` | —                                                | fleet agents + capabilities (pick an `agentName`) |
| `get_agent`   | `name`                                           | one agent's full definition |
| `create_task` | `prompt`, `title?`, `agentName?`, `references?`  | id + `task://<id>` |
| `get_task`    | `id`                                             | status, summary, prUrl, subtasks |
| `list_tasks`  | `q?`, `page?`, `pageSize?`                        | paginated list |
| `wait_for_task` | `id`, `timeoutSec?`                            | blocks until settled → status + `awaitingInput`/`awaitingApproval` |
| `follow_up`   | `id`, `message`                                  | answer a question / add context (task must be settled) |
| `approve_task`| `id`                                             | approve the task's pending gate → unblocks the run |
| `deny_task`   | `id`                                             | deny the pending gate |
| `cancel_task` | `id`                                             | new status |
| `list_docs`   | —                                                | project doc paths |
| `read_doc`    | `path`                                           | a doc's markdown |

`list_docs` / `read_doc` are tool mirrors of the `doc://` resources, for
tool-only clients (e.g. claude.ai) that can't read MCP resources directly.

Resources:
- `guide://usage` → the usage guide (same content as the `help` tool).
- `task://{id}` → JSON view of a task (status, summary, PR, subtasks).
- `doc://{path}` → the project repo's markdown docs. `resources/list` enumerates
  every `*.md`/`*.mdx` under the repo (hidden/build dirs skipped); reading one
  returns its text. Lets a client pull project context before creating a task.
  Restricted to markdown and confined to the repo — it can't surface source or
  a stray `.env`.

## Connect

### Claude Code
```bash
claude mcp add --transport http lds-fleet http://localhost:3001/api/mcp
```

### Claude Desktop (Custom Connector)
Settings → Connectors → Add custom connector → URL `http://localhost:3001/api/mcp`.

### Browser MCP client
Same URL. CORS exposes the `Mcp-Session-Id` header so a browser client can
carry the session. A dashboard/tool served over `http://localhost` connects
fine.

### claude.ai (web) — via an ngrok tunnel
claude.ai connects to a custom connector **from Anthropic's servers**, not your
browser — so it needs a public HTTPS URL (which also sidesteps mixed content).
Expose the orchestrator with a tunnel:

```bash
ngrok http 3001
# → Forwarding https://xxxx.ngrok-free.app -> http://localhost:3001
```

Then, in claude.ai → Settings → Connectors → Add custom connector, use:

```
https://xxxx.ngrok-free.app/api/mcp?key=<MCP_TOKEN>
```

**Set `MCP_TOKEN` before doing this** (see below) — the tunnel makes the
endpoint world-reachable, and this endpoint can create/cancel tasks on your
machine. The `?key=` form carries the token because claude.ai connectors can't
attach custom headers.

Gotchas:
- Free ngrok injects a browser-warning interstitial. If the connector fails to
  handshake, add `--request-header-add "ngrok-skip-browser-warning: 1"` to the
  ngrok command (or use a reserved domain / paid plan).
- If you set `MCP_ALLOWED_ORIGINS`, include `https://claude.ai`.
- Already on a public host (VPS/Railway/etc.)? Skip ngrok — use that URL +
  `?key=` directly.

## Config

- `MCP_HOST_ENABLED` (default `true`) — set `false` to disable the endpoint (404).
- `MCP_ALLOWED_ORIGINS` — optional comma-separated `Origin` allowlist. When set,
  enables DNS-rebinding protection (the MCP-spec-recommended guard for local
  servers). Empty = accept any origin.
- `MCP_TOKEN` — access token. Empty = open. When set, every request must present
  it as `Authorization: Bearer <token>` or a `?key=<token>` query param.

## Security

Localhost-only: leaving `MCP_TOKEN` empty matches the server's "no-auth v1"
posture (single operator on a trusted machine). The optional `MCP_ALLOWED_ORIGINS`
allowlist guards against a malicious local web page.

**Exposed publicly (ngrok / VPS): set `MCP_TOKEN`.** This endpoint can create and
cancel tasks — a public URL without a token means anyone who learns it can drive
your fleet. Use a long random value (`openssl rand -hex 32`) and keep it out of
git; the tunnel/host URL plus `?key=<token>` is the only thing a client needs.
