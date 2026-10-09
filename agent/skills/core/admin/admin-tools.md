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
| `request_secret` | `target` (`provider`\|`github_token`\|`channel`), `name?` (provider or channel name), `reason` | Shows the user a SECURE field (dashboard card, hidden console prompt, or a one-time link on a phone). The key goes straight to the server; you never see it and it is not in the chat. Blocks until they save or cancel; returns saved or not |
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
| `packs_list` | – | Ready-made content packs (English learning, Home renovation, Software team): what each contains and how much is already installed |
| `propose_pack_install` | `name`, `timezone?`, `reason` | Installs a pack: its agents, skills, starter notes in the project library and prepared schedules (created **switched OFF**). Never overwrites anything that exists, so it is safe to repeat. Ask the user's time zone first |
| `resources_search` | `query?`, `tag?` | Searches the project's resource library (notes, images, documents every agent can use as knowledge): id, title, kind, tags, description, file path |
| `propose_resource` | `action` (`create`\|`update`\|`delete`), `id?`, `title?`, `description?`, `tags?`, `agents?`, `text?` (Markdown), `reason` | Adds/changes/deletes a TEXT NOTE in that library (approval). Files and images are uploaded by the user in the dashboard → Resources — you cannot create those. `description` is one line saying when an agent should read it; `agents` = who it is for (omit = all). Search first to avoid duplicates |
| `channels_list` | – | Chat channels (Telegram): on/off, whether a bot token is set, a live connection check, allowed chats, default agent, and chats that **wrote to the bot but are not allowed yet** (id + first message) |
| `propose_channel` | `action` (`create`\|`update`\|`delete`), `name`, `kind?` (`telegram`), `enabled?`, `defaultAgent?`, `allowChatId?`, `removeChatId?`, `reason` | `create` makes a channel **switched off, without a token**; then call `request_secret` (target `channel`) — it switches on by itself when the token is saved. `allowChatId` lets that chat create tasks and approve actions: only a chat the user confirmed is theirs. No secret in this call |
| `schedules_list` | – | Recurring jobs: name, when (in words), kind and target, next run, last result |
| `propose_schedule` | `action` (`create`\|`update`\|`delete`), `name`, `cron?`, `timezone?`, `kind?` (`message`\|`task`), `text?`, `agentName?`, `channel?` (NAME), `chatId?`, `quietStart?`/`quietEnd?`, `enabled?`, `reason` | Creates/changes/deletes a recurring job. `message` posts text to a chat (no model, free — for reminders); `task` starts an agent on a prompt each time (uses model budget; updates go to the chat). `cron` = `minute hour day-of-month month day-of-week` (e.g. `30 9 * * *` daily 09:30, `0 8 * * 1-5` weekdays 08:00, `0 18 * * 0` Sundays 18:00; never more often than every 5 min). Ask the user for the time zone — don't guess. One job per call (not part of `propose_batch`) |
| `access_status` | — | Read-only: allowed domains (enforced or not), the `PUBLIC_URL` host, whether Cloudflare Access is set up / on |
| `propose_allowed_domains` | `action` (`add`\|`remove`\|`set`\|`clear`), `domains?`, `reason` | Changes the list of domain names the server answers to (`dev.example.com`, `*.example.com`). `localhost`, IP addresses and single-word names always work. Once the list exists, OTHER public names stop working |
| `propose_cloudflare_access` | `enabled`, `teamDomain`, `aud?`, `reason` | Turns the server's own Cloudflare Access check on/off (team domain `yourteam.cloudflareaccess.com`; AUD tag from the Access application's Overview — an identifier, not a secret). First checks that Cloudflare answers for that team. When on, a request under a real domain name without Cloudflare's signed token gets 403; `localhost`/IPs/LAN unaffected |
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

**Set up for a kind of project (packs).** When the user describes a project that matches a pack (learning English → `english`, repair/renovation of a home → `renovation`, building software → `development`): `packs_list` → explain in two sentences what the pack gives them → ask their time zone → `propose_pack_install`. Then walk through its "next steps" from the result: they fill in the profile/brief note in 📚 Resources (offer to help write it: `propose_resource` can update it), connect Telegram if they want reminders there (see "Connect Telegram"), and choose the chat for the prepared schedules (Settings → Schedules → Turn on) — or you create the reminder yourself with `propose_schedule`. Never start the pack's schedules without the user's go-ahead: they spend model budget.

**Project knowledge (resources).** The project keeps a shared library (dashboard → 📚 Resources): notes, photos, PDFs, documents that EVERY agent sees in its prompt (title + description + path) and reads when relevant. When the user tells you a lasting fact an agent should always know (house measurements, a learner's level and goals, a style guide, a glossary) → `resources_search` (is it already there?) → `propose_resource` with a short note, a one-line description and tags. Photos/files: tell them to upload them in Resources (drag & drop) and write a description — agents choose what to read by it. A scoped note (`agents`) is only shown to those agents.

**Connect Telegram.** 1) The user creates a bot with @BotFather (just tell them to message it, `/newbot`, and keep the token private). 2) `channels_list` (avoid duplicates) → `propose_channel` action `create`, `name` (e.g. "telegram"). 3) `request_secret` target `channel`, name = that channel — the user pastes the BotFather token into a SECURE field (a card in the dashboard, a hidden prompt in the console, or a one-time link on a phone); NEVER ask for the token in the chat. It switches on by itself; the result tells you whether the connection check passed. 4) Ask them to send any message to the bot; call `channels_list` — their chat is listed as WAITING with its id and first message → confirm with the user that it is theirs → `propose_channel` action `update`, `allowChatId`. (The user can also press Allow in Settings → Channels.) Do all of this from the chat — no forms needed. If you are talking to the user *through Telegram*, key entry arrives as a one-time link in the chat.

**Reminders and periodic tasks.** Ask what, when (days + time), where (which channel/chat — `channels` are in Settings → Channels; the chat must already be an allowed chat) and the user's time zone, whether it should only remind (`message`, free) or make an agent work (`task`, uses budget), and whether there are quiet hours. Then `schedules_list` (avoid duplicates) → `propose_schedule`. Tell the user how to see/pause it: Settings → Schedules (Run now / Turn off). A missed run (server off) is skipped, not fired late.

**Who may reach the server from outside.** `access_status` first. Domains: ask which public name(s) they use and make sure THEIR OWN address stays on the list (once the list exists other public names stop working; localhost / IP / LAN always work) → `propose_allowed_domains`. Cloudflare Access: they create the Access application in Cloudflare (steps in `docs/remote-access.md`) and give you the team domain and the AUD tag → `propose_cloudflare_access` (it checks Cloudflare first). `PUBLIC_URL` and the listen address live in the server's `.env` — you cannot change them: tell the user to run `aigentron access` on the server. A random sub-domain alone is not protection — the passwords (Settings → Security) matter most.

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
