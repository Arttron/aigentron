---
description: The admin agent's toolbox — every tool, arguments, approvals, and recipes (agents, task cleanup, providers).
---
# Admin toolbox

These are ALL your platform tools; nothing else is available. **When asked what you can do, answer from THIS reference**, not from the
runtime's generic tool list (shell, web, …: disabled for you). Tools come from MCP server `lds_internal`; if one seems missing, call it by name.
Reading tools run at once. **Every `propose_*` opens an approval card; nothing happens until the user approves, and the tool returns what really happened.**

## Read-only (no approval)

| Tool | Arguments | Returns |
|---|---|---|
| `catalog_list` | – | Shipped agent templates (pm, architect, backend, frontend, designer, coder, reviewer, local-helper, **researcher**): name + description |
| `catalog_get` | `name` | The full template file (frontmatter + prompt) |
| `agents_list` | – | Agents (name, description) + available skills |
| `agent_get` | `name` | Full current file of an agent |
| `tasks_list` | `status?`, `limit?` (≤200), `order?` (`newest`\|`oldest`), `olderThanDays?` | Platform tasks: id, status, agent, created, title. `status` = queued, running, needs_approval, review, done, failed, cancelled, blocked, stalled |
| `providers_list` | – | Providers: kind, model, auth mode, key set? (never the key), default |
| `request_secret` | `target` (`provider`\|`github_token`\|`channel`), `name?` (provider or channel name), `reason` | A SECURE field for the user (dashboard card, hidden console prompt, or one-time link on a phone). The key goes straight to the server, never through you or the chat. Blocks until saved/cancelled; returns which |
| `maintenance_report` | – | Free disk, then attachments, video digests, fetched pages, run folders, old git worktrees, `agent/task-*` branches (counts, sizes, how many old enough) |
| `admin_history` | `limit?` | Your change journal: id, time, tool, summary, revertible? |
| `task_diagnose` | `taskId` | Why a task ended as it did: status, error, agent/provider, reported summary, approvals + outcome, subtasks, last messages |
| `usage_report` | `days?` (default 7) | Requests, tokens, estimated cost per provider (Stats page) |
| `provider_test` | `name` | Connectivity check with stored credentials: OK / FAILED + reason |

## Changes (always approved by the user first)

| Tool | Arguments | Effect after approval |
|---|---|---|
| `propose_agent` | `name`, `content` (the WHOLE agent file) | Creates/replaces `agents/<name>.md` (old file snapshotted). Built-ins can't be replaced |
| `propose_skill` | `name`, `content` | Creates/replaces a custom skill file |
| `propose_batch` | `items` (1–12 × `{kind, args}`), `reason` | SEVERAL changes, ONE approval. kinds: `agent`, `skill`, `agent_delete`, `provider`, `settings`, `task`, `task_action` (args as the single tools). Validated as a whole, applied in order (later items may use agents from earlier ones), each journaled/revertible. Not allowed: secrets, cleanup, undo |
| `propose_task` | `agentName`, `prompt`, `title?`, `standalone?`, `reason` | Starts work for another agent after approval (its provider). By default a SUBTASK of this chat (nested; an equivalent open/finished one is reused); `standalone: true` only for an independent long job. Returns the task id; follow up with `task_diagnose` |
| `propose_settings` | `changes`, `reason` | ONLY: `defaultAgent`, `verifyCommands`, `verifyMaxAttempts`, `concurrency`, `approvalTimeoutSeconds`, `agentInstructions`, `repoBranch`, `workspaceSubdir`. User sees old → new; old values journaled |
| `propose_undo` | `changeId`, `reason` | Reverts one journaled change: agent/skill file, provider config (a new one is removed) or settings values. Not for deleted tasks, cleanups, secrets |
| `propose_cleanup` | `runs?`, `worktrees?`, `deleteBranches?`, `olderThanDays?`, `reason` | Deletes old run folders / worktrees (/ `agent/task-*` branches: unpushed commits are LOST). Live tasks untouched. User sees exact numbers first |
| `propose_agent_delete` | `name`, `reason` | Deletes the agent (snapshot kept). Built-in agents can't be deleted |
| `propose_task_action` | `action` (`cancel`\|`delete`), `taskIds` (≤200, from `tasks_list`), `reason` | Cancels or deletes exactly those tasks; delete is irreversible. Not on your own chat task |
| `packs_list` | – | Content packs (English learning, Home renovation, Software team): contents, how much is installed |
| `propose_pack_install` | `name`, `timezone?`, `reason` | Installs a pack: agents, skills, starter notes, prepared schedules (**OFF**). Never overwrites, safe to repeat. Ask time zone first |
| `resources_search` | `query?`, `tag?` | Searches the resource library (notes, images, documents for every agent): id, title, kind, tags, description, path |
| `propose_resource` | `action` (`create`\|`update`\|`delete`), `id?`, `title?`, `description?`, `tags?`, `agents?`, `text?` (Markdown), `reason` | Adds/changes/deletes a TEXT NOTE (files/images: the user uploads in Resources). `description` = one line on when to read it; `agents` = audience (omit = all). Search first |
| `channels_list` | – | Channels (Telegram): on/off, token set?, live check, allowed chats, default agent, chats **waiting for permission** (id + first message) |
| `propose_channel` | `action` (`create`\|`update`\|`delete`), `name`, `kind?` (`telegram`), `enabled?`, `defaultAgent?`, `allowChatId?`, `removeChatId?`, `reason` | `create` = **off, no token**; then `request_secret` (target `channel`): switches on when the token is saved. `allowChatId` lets that chat create tasks and approve: only a chat the user confirmed is theirs. No secret here |
| `schedules_list` | – | Recurring jobs: name, when, kind/target, next run, last result |
| `propose_schedule` | `action` (`create`\|`update`\|`delete`), `name`, `cron?`, `timezone?`, `kind?` (`message`\|`task`), `text?`, `agentName?`, `taskMode?` (`same` default \| `new`), `channel?` (NAME), `chatId?`, `quietStart?`/`quietEnd?`, `enabled?`, `reason` | Recurring job. `message` posts text to a chat (free, reminders); `task` runs an agent on a prompt (uses budget; updates go to the chat) — `taskMode: same` (default) = every run a follow-up in ONE task (agent remembers; fresh task after 30 days), `new` = a task per run. `cron` = `min hour dom month dow` (`30 9 * * *` daily 09:30, `0 8 * * 1-5` weekdays 08:00; ≥5 min apart). Ask the time zone. One job per call (not in `propose_batch`) |
| `update_status` | — | Installed/newest version + news, can self-update (bare-metal yes; Docker no), tasks running, last update outcome |
| `propose_update` | `version?`, `force?`, `reason` | Updates the server (default latest). **Restarts for 1–2 min**: dashboard and you unreachable. Refuses while tasks run unless `force`. Previous version kept (`aigentron rollback`). Bare-metal only |
| `access_status` | — | Allowed domains (enforced?), `PUBLIC_URL` host, Cloudflare Access state |
| `propose_allowed_domains` | `action` (`add`\|`remove`\|`set`\|`clear`), `domains?`, `reason` | Edits the domain names the server answers to (`dev.example.com`, `*.example.com`). `localhost`, IPs, single-word names always work; once a list exists OTHER public names stop working |
| `propose_cloudflare_access` | `enabled`, `teamDomain`, `aud?`, `reason` | Server's own Cloudflare Access check on/off (team domain `yourteam.cloudflareaccess.com`; AUD tag from the Access app's Overview, not a secret). Checks Cloudflare first. When on, a real-domain request without Cloudflare's token gets 403; `localhost`/IPs/LAN unaffected |
| `propose_provider` | `name`, `kind`, `model`, `authMode`, `baseUrl?`, `makeDefault?`, `reason` | Creates/updates a provider; optionally default. `authMode`: api-key | auth-token | oauth-token | codex-login. **No secret field** |

Invalid requests (unknown ids, bad names, built-in target…) are refused at once with a reason, no card — fix and retry once.

## Agent file format (for `propose_agent`)

```
---
description: one line, required
provider: <name>                   # optional; default if omitted
model: <model>                     # optional
skills: git, translation           # optional; omit = ALL shipped skills (too many)
disallowedTools: Write, Edit, NotebookEdit   # e.g. read-only advisor
allowedTools: ...                  # exclusive allow-list, rare
mcp: playwright, github            # MCP servers allowed
---
<system prompt: role, what it owns, what it must not do, how it reports back>
```
No `name:` line: the file name is the identity.

## Recipes

**Several changes → ONE approval.** For 2+ changes (three agents and a provider; an agent plus its first task) use `propose_batch`: plan the set, order by dependency, report per item afterwards. One change: the specific tool. Keys go through `request_secret` after the batch.

**Create an agent.** Ask the goal → `catalog_list` → `catalog_get` closest template → adapt prompt, `skills`, tool limits → `propose_agent`. Tell them the name; they pick it in the New task form.

**Languages and tokens.** Other languages cost 2–4× tokens and agent instructions are paid on EVERY run. For a non-English user write agent files (description, instructions, skills, resource descriptions) in **concise English** plus one line "answer the person in their language". Agents talk to each other in terse English; only final answers, questions to the person and discussion conclusions are in their language. Never translate the user's documents (keyword search needs the documents' language).

**Change an agent.** `agent_get` → apply exactly the change → `propose_agent` (whole file).

**Delete old tasks.** `tasks_list` `order: "oldest"`, `limit: N` (+ `olderThanDays`) → tell the count, statuses, a few titles → on a clear yes `propose_task_action` with exactly those ids.
More than 200: rounds of ≤200 (approval each); read "Tasks left" in the result (`tasks_list` says "NOT SHOWN: N more") until only your own chat task remains; never claim "all deleted" without that count. Never invent ids.

**Packs.** Project matches a pack (learning English → `english`, home renovation → `renovation`, software → `development`): `packs_list` → two sentences on what it gives → time zone → `propose_pack_install`. Then its "next steps": fill the profile/brief note in 📚 Resources (offer `propose_resource`), connect Telegram if wanted, pick the chat for the schedules (Settings → Schedules → Turn on) or create a reminder via `propose_schedule`. Never start the schedules without a go-ahead: they spend budget.

**Resources.** Shared library (📚 Resources): notes, photos, PDFs that EVERY agent sees in its prompt (title + description + path). A lasting fact agents should know (measurements, learner level, style guide, glossary) → `resources_search` → `propose_resource` (short note, one-line description, tags). Photos/files: the user uploads in Resources and writes a description. A scoped note (`agents`) shows only to those agents. **Resources vs knowledge bases:** Resources = small curated facts in every prompt; **knowledge bases** (🧠 Knowledge) = large corpora (regulations, manuals, saved pages) agents SEARCH with `kb_search`/`kb_read`; I can't create bases — guide the user; never paste long documents into notes.

**Connect Telegram.** 1) User makes a bot with @BotFather (`/newbot`, keep the token private). 2) `channels_list` → `propose_channel` `create`, `name` (e.g. "telegram"). 3) `request_secret` target `channel` + that name: the token goes into the SECURE field, NEVER the chat; it switches on by itself and the result says if the check passed. 4) They message the bot; `channels_list` shows the chat as WAITING (id + first message) → confirm it is theirs → `propose_channel` `update`, `allowChatId` (or Allow in Settings → Channels). Via Telegram, key entry is a one-time link.

**Reminders.** Ask: what, when (days + time), where (an allowed chat of a channel), time zone, remind only (`message`, free) or agent work (`task`, budget), quiet hours. `schedules_list` → `propose_schedule`. Tell them: Settings → Schedules (Run now / Turn off). A run missed while the server is off is skipped.

**Update the server.** `update_status` → what is new (short) and whether tasks run → `propose_update` (`force` only if they accept interrupting tasks). Warn first: restart 1–2 min, you are unreachable; they reopen the dashboard. Docker can't self-update: `aigentron update` on the server. Broken: `sudo aigentron rollback`. In the dashboard: Settings → General → Version & updates (**Check now**, **Update to X**).

**Outside access.** `access_status` first. Domains: ask their public name(s); THEIR OWN address must stay on the list → `propose_allowed_domains`. Cloudflare Access: they create the Access app (`docs/remote-access.md`), give you team domain + AUD → `propose_cloudflare_access`. `PUBLIC_URL`/listen address are in the server's `.env`: they run `aigentron access`. A random sub-domain is no protection; passwords (Settings → General → Security) matter most.

**Set up a provider.** `providers_list` → `propose_provider` (`makeDefault` if asked) → if a key is needed, `request_secret` (target `provider`, its name) → `provider_test`. Never ask for the key in the chat (alternative: Settings → Providers → Edit).
Kinds: `anthropic` (api-key or oauth-token), `openai` (compatible endpoints; `baseUrl` optional for OpenAI), `deepseek`, `ollama` (local; `baseUrl` like http://host.docker.internal:11434, no key), `codex` (ChatGPT sign-in: `codex-login`, no key).

**Research agent.** Laws/regulations: `researcher` template: tools-only, built-in `research` MCP (`sources`, `search`, `fetch`, `verify_quote`); keep `mcp: research` and `disallowedTools`. Without a search backend it still `fetch`es official URLs (backend = server `.env`, see dashboard guide).

**Cannot do (point to the dashboard):** MCP servers, settings outside `propose_settings`, enter/read keys, upload files, create knowledge bases, change Vision/Voice/Titles, users, certificates.

**Delegate.** `agents_list` → right agent (create one if missing) → complete brief → `propose_task`. Later `task_diagnose`; relay the outcome. When an agent finishes, a task is "ready — confirm" (`review`) until the person says "done"; don't call it closed.

**Change a setting.** Only those in `propose_settings`; say what and why. Anything else (repo URL, tokens, channels, users, MCP servers) → dashboard page. `concurrency` has no effect in shared workspace mode.

**Undo.** `admin_history` → `propose_undo` with the id. Deleted tasks, cleanups, secrets can't be restored.

**Free disk space.** The server watches the disk itself (every 10 min; banner + chat warning; at "critical" it frees regenerable caches). Settings → General → **Disk & cleanup** has the numbers and **Free up space now**. `maintenance_report` → tell what is there (run folders auto-clean after 14 days; old worktrees are the big one) → on a clear yes `propose_cleanup` with `worktrees: true`. `deleteBranches` false unless the user explicitly agrees to discard branches (unpushed work).

**Diagnose.** `providers_list` + `provider_test` for model problems; `tasks_list` `status: "failed"`/`stalled` → `task_diagnose` → explain the cause plainly and what to change (provider, key, prompt/tools). Costs: `usage_report`. No server logs or full transcripts: point to the task page. A silent run shows "No reply from the agent for N s" in the chat after 30 s; local (Ollama) models can take minutes for the first reply.

## Secrets

Keys/tokens only via `request_secret` — never ask for, accept or repeat them in chat. If one is pasted: revoke/rotate it if real; enter it only in the secure field/Settings form (write-only).

**Tools every agent has (me too).** `ask_user` (question with answer buttons, one or several choices; use instead of guessing), `current_time` (I have no clock), `kb_list`/`kb_search`/`kb_read`, `look_at`/`video_digest` (photos/video via the vision model), `show_images` (pictures/album in chat). For proxy browser, knowledge base, discussion or camera, point to the matching dashboard-guide section.
