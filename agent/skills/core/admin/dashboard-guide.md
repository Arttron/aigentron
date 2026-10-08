---
description: Map of the dashboard — where each page, tab, form and button is, and click-by-click how-tos (add a provider, set the default, create an agent, connect a repo, answer approvals).
---
# Dashboard guide

Use this to tell the user EXACTLY where to click. Names below are the real labels in the interface. If you are not sure
something exists, say so rather than inventing a menu item.

## Layout

- **Top bar of the main page (`/`)**: user switcher, connection indicator, then links **🧑‍💻 Agents**, **📊 Stats**, **⚙ Settings**.
- **Bottom-left**: theme toggle. **Bottom-right**: the mascot — click it to open this chat. Approval cards appear
  next to it (bottom-right) when an agent needs a decision.
- **Main page (`/`)**: the **New task** form on top (prompt, agent picker whose first option is the default lead,
  attachments, "references" to earlier tasks) and the task list below (search box, pages; subtasks are grouped under their parent).
- **A task page (`/tasks/<id>`)**: the conversation (transcript), pending approvals, a follow-up box to keep talking to the
  agent, buttons to cancel or delete the task, attachments, links (PR / pushed branch) when there are any.

## Console (no dashboard needed)

The same admin assistant is available in a terminal on the server: **`aigentron-admin`** (bare-metal / minimal image: run it in the
shell or `docker exec -it <container> aigentron-admin`; dev compose: `make admin`). It resumes the user's last console chat
(`/new` for a fresh one, `/help` for commands), shows my approval cards as text — type **a** to approve, **d** to deny, **v** to view the
full content — and asks for keys in a **hidden prompt** that goes straight to the server (it is the console form of the secure key card).
One-shot use: `aigentron-admin "how do I add a provider?"`. Useful for the very first setup when the dashboard isn't reachable.

## Sign-in

The dashboard can be protected by passwords: Settings → General → **Security** sets the first one (the default operator's; a banner
appears until then), and Settings → **Users** → 🔑 gives every other user their own. At the login screen a person picks their name and types
the password; their role decides what they may do. Agents on the server can't use the API to approve their own requests. I can't
set or read passwords — send the user to those screens. Forgotten: another operator resets it in Users, or `make reset-password` on the
server (removes all). Details: `docs/authentication.md`.

## Starter packs

On the Agents page, **Starter packs**: ready-made teams for a kind of project — *English learning* (tutor, curriculum planner, quiz maker), *Home renovation* (planner,
estimator, interior designer, materials advisor), *Software team* (PM, architect, backend, frontend, designer, reviewer). **Install** adds the agents, a skill, starter notes in
the library (a profile/brief to fill in) and prepared schedules (**switched off**). It never overwrites anything you already have, so pressing it again only fills gaps. I can do it
for you (`propose_pack_install`) and help fill in the notes.

## Resources — the project's shared knowledge

📚 **Resources** (link in the header of the task list): a library of notes, images, PDFs and any files. **Every agent of the project sees it** — its prompt carries the list (title, one-line description, tags) and it reads what is relevant, so a clear description matters more than the file name. Upload (button or drag & drop, up to 25 MB each, 500 MB total), or write a note (Markdown); give tags; optionally limit an item to chosen agents (none ticked = all). Typical contents: house measurements and reference photos (renovation), a learner profile and a vocabulary list (language learning), a style guide, a price list. Agents never change these files; people edit them here, and I can add or change text notes (`propose_resource`, with approval) and search them (`resources_search`).

## Channels (Telegram) and getting a new chat in

Settings → **Channels**. Telegram needs a bot (create one with @BotFather) and its token — the token is entered in a secure field, never in the chat. Only chats on the channel's
allow-list can use the bot. When someone writes to the bot from a chat that is **not** allowed, the bot replies with that chat's id and the dashboard shows a yellow
"is this you?" line under the channel with **Allow / Dismiss** (it forgets strangers after an hour). I can set the whole thing up (`propose_channel`, `request_secret`,
`channels_list`). When a request for a key comes through Telegram, the bot sends a one-time link (needs `PUBLIC_URL`) to a small page where the key is typed — the link works once, for 10 minutes, and can only fill that one value.

## Schedules (reminders and periodic tasks)

Settings → **Schedules**: recurring jobs. Each one has a time ("every day at 09:30", weekdays, certain days, every N hours, or a raw cron), a time zone,
optional quiet hours, and what it does — **post a message** to a chat (free, for reminders) or **start a task** for an agent (uses model budget; its updates arrive
in that chat). Buttons: Run now (try it), Turn on/off, Edit, Delete. A run missed while the server was off is skipped, not fired late. I can create/change/delete them
(`propose_schedule`, with approval) and list them (`schedules_list`).

## Public access (domains, Cloudflare)

To open the dashboard from outside, the user has two ways (or both): **A. built-in** — passwords (above) plus Settings → General → **Access**, a list of
allowed domain names (empty = any; `localhost`, IP addresses and single-word names always work, so a port forward / `ssh -L` is never affected); and
**B. Cloudflare Access** — an alternative or extra layer: Cloudflare asks the visitor to sign in (e-mail code / Google / GitHub) before the server is reached; set up
in the Cloudflare dashboard, steps in `docs/remote-access.md`. A random sub-domain alone is not protection. I can't change these settings — point the user to those screens or that doc.

## Approvals

An agent that wants to do something risky stops and shows a card: **Approve** or **Deny**. Under **Options** you can tick
"Don't ask again for this exact call in this task" or "…anywhere (global; expires after 30 days by default)" — for MCP tools the exception covers only the same arguments, not the whole tool. When I need several changes I put them on ONE card ("N changes in one approval") — each item can be expanded; approving applies them in order. Cards from me (the admin) show the full change and
have no "don't ask again" — each one is reviewed on its own. Runs have guard rails set in the server's `.env` (not changeable by me): `AGENT_IDLE_TIMEOUT_MS` aborts a run that went silent (not while an approval is pending), `BUDGET_TOKENS_PER_TASK` / `BUDGET_TOKENS_PER_DAY` make a task "blocked" with an explanation when its token budget is used up. Approvals time out (deny) after the time set in
Settings → General → Approvals.

## Agents page (`/agents`)

List of agents with **Edit** and ✕ (the built-in admin has a "built-in" badge instead — it can't be deleted).
**+ New agent** opens the form. At the top, **Start from a template** (optional) lists the shipped templates (pm, architect, backend, frontend,
designer, coder, reviewer, local-helper, researcher) — picking one pre-fills every field; then set the *Name*, choose a *Provider*, edit anything and save.
Fields: name, description, provider, fallback providers, model, skills, allowed/disallowed tools, MCP servers, and the system prompt ("instructions"). I can create and edit agents for the user via approvals — they can
also do it by hand here.

## Stats (`/stats`)

Token and request usage per provider with ranges: Today, 7 days, 30 days, All time.

## Settings (`/settings`) — tabs

**General**: Repository (GitHub) — *Repo URL* (blank = local workspace, no remote), *Base branch*, *GitHub token*,
*Project subdirectory* (a RELATIVE folder inside the repo such as `apps/web`, or empty for the repo root — a git address/URL here is rejected; the URL goes in *Repo URL*); *Default lead agent*; *Escalations* (default channel + chat/thread id for questions from tasks with
no channel); *Agent instructions (skill)* — text appended to every agent's prompt; *Verification gate* — commands run after
each run + max auto-fix attempts; *Task queue* — concurrency; *Approvals* — timeout in seconds; *Display* — theme.

**Providers**: card "Providers (model endpoints)" with **+ Add provider**, the **Default provider** selector ("used by tasks
that don't pick an agent"), and one row per provider with **Test**, **Edit**, delete. The form fields: *Name*, *Kind*,
*Base URL*, *Auth mode*, *Secret*, *Default model* (with **Load models**), *Rate limits*.

**LiteLLM**: the model routes of the LiteLLM gateway (advanced).
**MCP servers**: external tool servers agents can use. Each has a JSON config; the list shows the built-in ones
(playwright, github, postgres, code-intel and **research**). To add one: type a *name* in the field above the JSON box
(the **Add** button stays disabled until a name is entered), edit the JSON (stdio `{command,args}` or `{type:"http",url}`;
SSE servers are skipped by the Codex runtime), press **Add**. A config may contain `"readOnlyTools": ["*"]` (or a list of
tool names) to mark a trusted server's tools read-only so agents don't need an approval for each call. Alternatively `"trustAnnotations": true` plus the **Discover tools** button: tools the server itself annotates as read-only (and not destructive) skip approvals, new/unannotated ones still ask. Agents use a server
only if its name is in their `mcp:` list (Agents page → Edit → *MCP servers*). I can change a few settings (default agent, verification gate, concurrency, approval timeout, agent instructions, branch, subdirectory) — never the repo URL or tokens — and revert my own changes. I can't change MCP servers myself — guide the user.
**MCP endpoint**: lets outside clients (e.g. Claude Desktop) drive this platform. **Channels**: chat channels such as
Telegram (**+ Add channel**). **Users**: people and their roles.

## How-tos

**Add a provider with an API key.** Settings → Providers → **+ Add provider** → pick *Kind* (anthropic / openai / deepseek),
fill *Name* and *Default model* (use **Load models** to pick one), set *Auth mode* (api-key for most), paste the key into
*Secret* → save → press **Test** on its row. The key is write-only: it is never shown again, only replaced.
I can pre-fill everything except the key with `propose_provider`, then show a secure card (`request_secret`) where the user types the key — it goes straight to the server, never through the chat (in the console it is a hidden prompt). The user can also open **Edit** and paste it themselves.

**Local models (Ollama).** Kind *ollama*, *Base URL* of the Ollama host (e.g. http://host.docker.internal:11434), no key.
Pick a model that supports tool calls — Test reports whether it emits real tool calls.

**ChatGPT subscription via Codex.** Kind *codex*, Auth mode *codex-login*, model e.g. gpt-6.1-sol. Then, once, in a terminal on the
server — with Docker: `docker compose exec -it -e CODEX_HOME=/workspace/secrets/codex orchestrator codex login --device-auth`;
bare-metal: `CODEX_HOME=<data dir>/secrets/codex codex login --device-auth` — open the printed link, enter the code, then press **Test**.
Agents using that provider run on the Codex runtime.

**Where the server keeps credentials.** Provider keys are stored write-only in the database. The Codex sign-in lives outside the agents' files in the secrets volume/dir (`/workspace/secrets/codex`, or `<data dir>/secrets/codex`). Agents are not allowed to read credential files without an approval.

**Disk space.** Task run folders are removed automatically after 14 days (`RUNS_RETENTION_DAYS` in `.env`; 0 = never). Old per-task git worktrees
from the former worktree mode are removed only on request — ask me to propose a cleanup (or `CLEANUP_WORKTREES=true` + `WORKTREE_RETENTION_DAYS` in `.env`).

**Make a provider the default.** Settings → Providers → *Default provider* selector (or I propose it with `makeDefault`).
The admin chat itself answers using the default provider.

**Give an agent a specific provider/model.** Agents page → Edit the agent → *Provider* and *Model*.
**Which model the admin itself uses.** By default the *Default provider*. To give the admin a stronger model than the rest of the fleet: Agents page → **admin** → Edit → set *Provider*/*Model* (only routing is editable for the built-in admin; its prompt and tools are fixed). A weak or local model may fumble tool calls — if I seem confused, that is the first thing to change.

**Connect a Git repository.** Settings → General → Repository (GitHub): *Repo URL* (needs saving), *GitHub token*, *Base branch*.

**Turn on checks after each run.** Settings → General → Verification gate: one command per line.

**Official-source research (laws, regulations).** Create an agent from the **researcher** template (I can do that) — it uses the
built-in `research` MCP server. `fetch` works out of the box for official domains (EU, UA, UK, US by default; the list is the
file `agent/research.json`: `{"jurisdictions": {"eu": ["eur-lex.europa.eu"]}}`). `search` needs a backend configured on the
server in `.env`: `BRAVE_API_KEY=…` or `RESEARCH_SEARXNG_URL=…` (then restart). PDFs aren't readable yet; standards (EN/ISO) are paid
and not on the web. Quotations are checked against what was actually read (`verify_quote`).

**Telegram.** Settings → Channels → **+ Add channel**; set a default escalation channel under General → Escalations.

## What I can and can't do for the user

I can explain any of the above, create/edit/delete agents, clean up tasks, and configure providers (except secrets), always
through approvals. I can't press buttons for them, change other settings, or see keys — for those I point to the exact
place above.
