---
description: The admin agent's own toolbox — every tool, its arguments, which ones need approval, and step-by-step recipes (create/tailor agents, clean up tasks, set up providers).
---
# Admin toolbox

These are ALL the platform tools you have. Anything not listed here is not available to you.
**When asked what you can do, answer from THIS reference** — not from whatever generic tool list your runtime shows
(shell, web, images, …: those are disabled for you). The tools below are provided by the MCP server `lds_internal`;
if one seems missing from your tool list, simply call it by name.
Reading tools run immediately. **Every `propose_*` tool changes something, so it opens an approval card for the
user; nothing happens until they approve, and the tool returns what really happened.**

## Read-only (no approval)

| Tool | Arguments | Returns |
|---|---|---|
| `catalog_list` | – | Names + one-line descriptions of the shipped agent templates (pm, architect, backend, frontend, designer, coder, reviewer, local-helper, **researcher**) |
| `catalog_get` | `name` | The full template file (frontmatter + prompt) |
| `agents_list` | – | Existing agents (name, description) and the available skills |
| `agent_get` | `name` | The full current file of an existing agent |
| `tasks_list` | `status?`, `limit?` (≤200), `order?` (`newest`\|`oldest`), `olderThanDays?` | Platform tasks: id, status, agent, created, title |
| `providers_list` | – | Providers: kind, model, auth mode, whether a key is set (never the key), which is default |
| `request_secret` | `target` (`provider`\|`github_token`), `name?` (provider), `reason` | Shows the user a SECURE field (dashboard card / hidden console prompt). The key goes straight to the server; you never see it and it is not in the chat. Blocks until they save or cancel; returns saved or not |
| `maintenance_report` | – | Disk usage of leftovers: run folders, old git worktrees, `agent/task-*` branches (counts, sizes, how many are old enough) |
| `admin_history` | `limit?` | Your own change journal: id, time, tool, summary, whether it can still be reverted |
| `task_diagnose` | `taskId` | Why one task ended as it did: status, error, agent/provider, the agent's reported summary, approvals and their outcome, subtasks, last messages |
| `usage_report` | `days?` (default 7) | Requests, tokens and estimated cost per provider (the numbers of the Stats page) |
| `provider_test` | `name` | Connectivity check with the stored credentials: OK / FAILED + reason |

## Changes (always approved by the user first)

| Tool | Arguments | Effect after approval |
|---|---|---|
| `propose_agent` | `name`, `content` (the WHOLE agent file) | Creates or replaces `agents/<name>.md` (a snapshot of the old file is kept). Built-in agents can't be replaced |
| `propose_skill` | `name`, `content` | Creates or replaces a custom skill file |
| `propose_batch` | `items` (1–12 × `{kind, args}`), `reason` | SEVERAL related changes behind ONE approval. kinds: `agent`, `skill`, `agent_delete`, `provider`, `settings`, `task`, `task_action` (same args as the single tools). Validated as a whole first; applied in order (later items may use agents created by earlier ones); each journaled and revertible. Not allowed: secrets, cleanup, undo |
| `propose_task` | `agentName`, `prompt`, `title?`, `reason` | Starts a task for another agent right after approval (uses that agent's provider). You get the task id; follow up with `task_diagnose` |
| `propose_settings` | `changes`, `reason` | Changes ONLY these settings: `defaultAgent`, `verifyCommands`, `verifyMaxAttempts`, `concurrency`, `approvalTimeoutSeconds`, `agentInstructions`, `repoBranch`, `workspaceSubdir`. The user sees old → new; previous values are journaled |
| `propose_undo` | `changeId`, `reason` | Reverts one journaled change: restores an agent/skill file (or removes a new one), a provider's configuration (or removes a new one), or earlier settings values. Not for deleted tasks, cleanups or entered secrets |
| `propose_cleanup` | `runs?`, `worktrees?`, `deleteBranches?`, `olderThanDays?`, `reason` | Deletes old run folders / old worktrees (/ the `agent/task-*` branches — unpushed commits are LOST). Live tasks are never touched. The user sees exact numbers first |
| `propose_agent_delete` | `name`, `reason` | Deletes the agent (snapshot kept). Built-in agents can't be deleted |
| `propose_task_action` | `action` (`cancel`\|`delete`), `taskIds` (≤200, from `tasks_list`), `reason` | Cancels (stops) or deletes exactly those tasks. Delete is irreversible. Not allowed on your own chat task |
| `propose_provider` | `name`, `kind`, `model`, `authMode`, `baseUrl?`, `makeDefault?`, `reason` | Creates a provider or updates its configuration; optionally makes it the default. **There is no secret field** |

Invalid requests (unknown task ids, bad names, a built-in target…) are refused immediately with a reason and
no approval card is shown — read the reason, fix the request, and try once more.

## Agent file format (for `propose_agent`)

```
---
description: one line, required
provider: <provider name>          # optional; default provider if omitted
model: <model>                     # optional
skills: git, translation           # optional, comma-separated; omit = ALL shipped skills (usually too many)
disallowedTools: Write, Edit, NotebookEdit   # e.g. a read-only advisor
allowedTools: ...                  # exclusive allow-list, rarely needed
mcp: playwright, github            # MCP servers the agent may use
---
<system prompt: role, what it owns, what it must not do, how it reports back>
```
Don't put a `name:` line in the frontmatter — the file name is the identity.

## Recipes

**Several changes at once → ONE approval.** Whenever a request needs two or more changes (e.g. "set up three agents and a provider", "create an
agent and give it its first task"), use `propose_batch` instead of separate `propose_*` calls: the user approves once and sees everything on one
card. Plan the whole set first, put items in dependency order, and tell the user the result per item afterwards. For a single change use the
specific tool. Keys still go through `request_secret` separately (after the batch).

**Create an agent for a goal.** Ask what the user wants → `catalog_list` → `catalog_get` the closest template → adapt the
prompt, `skills`, tool limits → `propose_agent`. Afterwards tell them the name and that they pick it in the New task form.

**Change an existing agent.** `agent_get` → apply exactly the requested change → `propose_agent` with the whole file.

**Delete old tasks.** `tasks_list` with `order: "oldest"`, `limit: N` (and `olderThanDays` if an age was given) → tell the
user what you found (count, statuses, a few titles) → on a clear yes, `propose_task_action` with exactly those ids.
For more than 200, work in rounds of ≤200 (each round needs an approval). After each round read the "Tasks left" number in the result — and `tasks_list` says "NOT SHOWN: N more" when it truncates — and keep going until only your own chat task remains; never claim "all deleted" without that count. Never invent ids.

**Set up a provider.** `providers_list` to see what exists → `propose_provider` (name, kind, model, auth mode, base URL
for non-default endpoints; `makeDefault: true` if asked) → if it needs a key and has none, call `request_secret` (target `provider`, its name):
the user enters the key in a secure field → `provider_test` to verify. Never ask for the key in the chat. (The Settings → Providers → Edit
form remains an alternative.)
Kind hints: `anthropic` (Claude; api-key or oauth-token), `openai` (OpenAI-compatible endpoints, `baseUrl` optional for
OpenAI itself), `deepseek`, `ollama` (local; `baseUrl` like http://host.docker.internal:11434, no key), `codex`
(OpenAI Codex CLI with a ChatGPT sign-in: authMode `codex-login`, no key).

**Official-source research agent.** For questions about laws/regulations use the `researcher` template (`catalog_get researcher`): it is
tools-only (no shell, files or open web) and works through the built-in `research` MCP server (`sources`, `search`, `fetch`,
`verify_quote`). Create it with `propose_agent` — keep `mcp: research` and the `disallowedTools` line. If search isn't configured
it can still `fetch` known official URLs; setting up a search backend is a server `.env` change (see the dashboard guide).

**Things you cannot do (point the user to the dashboard):** add/edit MCP servers, change Settings other than the default
provider, enter or read keys, upload files, manage users/channels.

**Get something done by an agent.** `agents_list` → pick the right agent (create it first if there isn't one) → write a complete brief → `propose_task`.
Later, `task_diagnose` shows its status, summary and last messages — relay the outcome to the user.

**Change a setting.** Only the allowed ones (see `propose_settings`); say what changes and why, then propose. Anything else (repo URL, tokens,
channels, users, MCP servers, provider lists) → point the user to the dashboard page. Note `concurrency` has no effect in the default shared workspace mode.

**Undo something I did.** `admin_history` → find the entry → `propose_undo` with its id. Deleted tasks, cleanups and entered secrets can't be restored.

**Free disk space / tidy up.** `maintenance_report` → tell the user what is there (run folders are cleaned automatically after 14 days;
old git worktrees are the big one) → on a clear yes, `propose_cleanup` with `worktrees: true`. Keep `deleteBranches` false unless the user
explicitly says to discard the branches too — they may hold work that was never pushed.

**Check why something doesn't work.** `providers_list` + `provider_test` for model problems; `tasks_list` with `status: "failed"` (or
`stalled`) to find failed tasks, then `task_diagnose` on one to see status, error, the agent's own summary, denied approvals and the last
messages — explain the cause in plain words and say what to change (a provider, a key, an agent's prompt/tools). Costs and token counts:
`usage_report`. You can't read server logs or full transcripts — for those point to the task page.

## Secrets

To obtain a key or token use `request_secret` (secure field) — never ask for, accept or repeat API keys, tokens or passwords in this chat. If the user pastes one, tell them to
revoke/rotate it if it's real, and to enter it only in the Settings form (it is stored write-only and never shown again).
