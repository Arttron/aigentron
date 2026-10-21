---
description: Map of the dashboard — pages, tabs, forms, buttons, and click-by-click how-tos (providers, agents, repo, approvals, tasks, chat, knowledge, disk).
---
# Dashboard guide

Tell the user EXACTLY where to click, with the real labels below. Never invent menu items.

## Layout

- **Main page (`/`)** header: user switcher, connection indicator, links **🧑‍💻 Agents**, **📚 Resources**, **🧠 Knowledge**, **📁 Workspace**, **📁 Projects**, **🌐 Browser**, **📊 Stats**, **⚙ Settings**. Then the **New task** form (prompt, agent picker — first option = default lead, 📎 attachments incl. **📷 Camera**, references to earlier tasks, **💬 Discuss**) and the task list (search, pages, filters).
- Bottom-left: theme toggle. Bottom-right: the mascot — click to open this chat; approval cards and agent questions appear next to it on every page.
- **Task page (`/tasks/<id>`)**: transcript, pending approvals, follow-up box, Cancel/Delete, attachments, PR/branch links, subtasks, **✅ Mark as done**, **💬 Discuss** (finished tasks).

## Task list

- **Status chips** (counts; empty hidden): *Needs attention* (approval, blocked, stalled, failed), *Active* (queued/running), *Ready*, *Done*, *Blocked*, *Approval*, *Failed*, *Stalled*, *Cancelled*. A status filter looks at every level (a blocked subtask under a finished parent is listed flat).
- **Type chips** ("Type:"): *Tasks* (started in the dashboard), *Chats* (with a chat agent such as me), *From chats* (Telegram), *Scheduled*, *Discussions*, *Subtasks* (listed flat). The choice is remembered and in the URL (`/?type=chat`).
- New tasks get a short title from a small model (Settings → **Task titles**); titles set by a person or schedule never change.
- **Subtasks** fold under their parent ("▸ 3 subtasks" + "2 done · 1 running"), also on the task page; remembered per task.

## Statuses: who sets "done"

**done** is set only by a person. An agent that finishes makes the task **ready — confirm** (`review`). The person says **"done"** / **"готово"** (a short message; longer text is a follow-up), presses **✅ Mark as done** (task header; Telegram: write "done") or sends `/done`. Else it continues. Blocked / stalled / failed can be accepted as is. Subtasks are accepted by their lead. Chip *Done* = confirmed by a person; *Ready* = waiting.

## Subtasks

Leads call `check_subtasks` and reuse an existing subtask; max 25 per task. New work from inside a task is a **subtask**. A lead closes a handled one with `complete_subtask`.

## The chat window (task page, this admin chat)

- Bar toggles: **terminal** (monospace, prompt-style, follows light/dark; 8-bit palette, stepped pixels) / **classic**, and **all steps** / **messages only** ("N step(s) hidden"). Per browser, remembered.
- **Ambient strip** under the chat: an activity light, decoration only. A small **copy icon** sits under every message (here too).
- While running, a line shows the work; after **30 s** of silence: "⏳ No reply from the agent for N s — it may still be thinking…" (an **Ollama** agent adds that a local model can take minutes for the first reply).
- Photo/video: click opens the viewer; **Ask about this moment** / **Mark and ask** freezes the frame, the person draws a rectangle and sends it as a follow-up.

## Console

Same assistant in a terminal: **`aigentron-admin`** (shell; dev compose: `make admin`). Resumes the last chat (`/new`, `/help`); cards as text — **a** approve, **d** deny, **v** view; keys via a **hidden prompt**. One-shot: `aigentron-admin "question"`.

## Sign-in

Settings → General → **Security** sets the first password (banner until set); Settings → **Users** → 🔑 gives others theirs. Login: name + password. I can't set/read passwords. Forgotten: another operator resets it in Users, or `make reset-password` on the server (removes all). `docs/authentication.md`.

## Agents page (`/agents`)

Tabs **Agents** and **Starter packs** (`/agents?tab=packs`). Agents tab starts with *Default lead agent* (saved on choice). List with **Edit** and ✕ (built-in admin: "built-in" badge, only routing — provider/model — editable). **+ New agent** / **Edit** dialog: **Start from a template** pre-fills; fields: name, description, provider, fallback providers, model, skills, allowed/disallowed tools, MCP servers, instructions. I can do it via approvals.
**Starter packs**: *English learning*, *Home renovation*, *Software team*. **Install** adds agents, a skill, starter notes and schedules (**off**); never overwrites. I can do it (`propose_pack_install`).

## 📚 Resources (`/resources`)

Notes, images, PDFs, files; agents see the list (title, description, tags) in their prompt and read what is relevant — a clear description matters most. Upload (≤25 MB each, 500 MB total; videos ≤300 MB) or write a note; tags; optionally limit to chosen agents. **Scope** (2+ projects): global = every agent of every project, project = only agents working on it. Agents never edit them; I add/change text notes (`propose_resource`) and search (`resources_search`).

## 🧠 Knowledge (`/knowledge`)

Large reference material agents search instead of carrying in the prompt. **+ New base** (name, one-line description, which agents; none = all); upload PDF / Word / Markdown / text / HTML / CSV, add a note, pick from Resources, or pull in saved web pages. Keyword search (BM25); an embedding provider in the base's settings adds meaning search. Agents use `kb_list`/`kb_search`/`kb_read` (`kb_add` if allowed). I can't create bases — guide the person.

## 📁 Workspace (`/workspace`)

Shared folder for non-code work: `WORKSPACE.md` (the brief, edited with ✎; every agent reads it), `memory/` (decisions, open questions, facts, plan, status — agents write with `workspace_note`), `work/` (drafts, data; upload here), `deliverables/` (results from `workspace_save`, versions kept). A **Project** picker switches to a project's own folder (brief `PROJECT.md`). Browse, preview, download, delete; `..` goes up, holds **Upload**.

## 📁 Projects (`/projects`)

Many projects: each has its own repo (access Public/Token/SSH key, **Test connection**, **Sync now**), checks, default agent, notify channel, mode shared/worktree; Settings → Repository = the Default one. Task form/list get a project picker at 2+. I can't enter tokens — guide.

## 🌐 Browser (`/browser`)

A real browser on the server (add-on). Not installed → the page shows its needs and the SSH command `sudo aigentron addon enable browser` (Docker: `--backend docker`) with copy buttons; I can't install it. Running → the live screen in the page (operator/admin; few viewers, 2 h per session; **Open in a new tab**, **Fullscreen**). Not answering → `aigentron addon logs browser`. Agents share it: its sign-ins are visible to them. `docs/addons.md`.

## Stats (`/stats`)

By provider: tokens, requests, cost (Codex "—"); Today/7/30 days/all.

## Settings (`/settings`) — tabs

General, Providers, LiteLLM, MCP servers, MCP endpoint, Channels, Schedules, Voice, Vision, Users, Signed-in devices.

**General** (cards, top to bottom):
- *Version & updates*: **Check now**, **Update to X** (operator confirms; restart 1–2 min; previous kept for `aigentron rollback`; Docker can't self-update: `aigentron update`). I can start it (`propose_update`).
- *Disk & cleanup*: free-space bar, what takes it, **Free up space now** (regenerable caches only). Checked every 10 min: low = banner + message to the default chat; critical = auto-clear. Attachments never auto-deleted.
- *Security* (passwords), *Access* (allowed domains, empty = any; `localhost`/IPs always work unless **Only these domains**), *Web server* (port 80 optional; PEM cert + key → HTTPS on 443; `aigentron access`), *Cloudflare Access* (team domain + AUD, Save, **Test**; requests on real domains without Cloudflare's token are refused; localhost/IP/LAN exempt). I handle domains and Cloudflare via `access_status`, `propose_allowed_domains`, `propose_cloudflare_access`.
- *Approvals*: **No approvals mode** (admin only) = the global level; a project (its settings) and a task (🛡 selector, subtasks follow) can override it, most specific wins. Off: no cards, except credentials/charter files and admin platform changes.
- *Run limits*: first time window, extension while still working, quiet limit, steps per run, and at the ceiling a card asks whether a working run may go on (+N min). Env vars are defaults.
- *Task titles* (see above).
- Then: *Repository (GitHub)* (*Repo URL* blank = local workspace; *Base branch*; *GitHub token*; *Project subdirectory* = RELATIVE folder like `apps/web`, a URL is rejected); *Escalations* (default channel + chat/thread for questions from tasks with no channel); *Agent instructions (skill)* appended to every prompt; *Verification gate* (commands per line after each run + max auto-fix attempts); *Task queue* (concurrency); *Approvals* (timeout, s); *Display*.

**Providers**: **+ Add provider**, **Default provider**, rows: **Test**, **Edit**, delete. Codex / Claude-oauth: **Sign in**. Form: *Name*, *Kind*, *Base URL*, *Auth mode*, *Secret*, *Default model* (**Load models**), *Rate limits*.
**LiteLLM**: model routes of the gateway (advanced).
**MCP servers**: built-in playwright, **playwright-proxy**, github, postgres, code-intel, **research**. Add: *name*, JSON (stdio `{command,args}` or `{type:"http",url}`), **Add**. `"readOnlyTools": ["*"]` (or names) marks tools read-only (no approvals); `"trustAnnotations": true` + **Discover tools**: server-annotated read-only tools skip approvals. Agents use a server only if in their `mcp:`. I can't change MCP servers.
**MCP endpoint**: outside clients (Claude Desktop) drive the platform. **Users**: people, roles. **Signed-in devices**: own sessions (operator/admin: all), **Sign out** per device / "my other devices" / "X everywhere".
**Voice**: speech-to-text (🎤) and text-to-speech (🔊); each a switch, *Provider* (kind OpenAI: OpenAI, Groq, local Whisper/TTS by Base URL), *Model*, *Language*/*Voice*, **Test**. Telegram `/voice on|off`; dashboard 🔊 and **🎙 Voice mode**. Cloud providers receive audio/text. Mic needs HTTPS/localhost. Needs a provider key: guide the user.
**Vision**: provider + model that describe photos/video frames (not Claude/Codex sign-ins; **Test** saves first). Without it `look_at` falls back to the agent's own cloud model. `docs/media.md`.
I can change only: default agent, verification gate, concurrency, approval timeout, agent instructions, branch, subdirectory — never repo URL/tokens — and revert my own changes.

## Channels (Telegram)

Settings → **Channels** (**+ Add channel**): needs a bot (@BotFather) and its token (secure field, never chat). Only allow-listed chats work. A message from a non-allowed chat gets its id back and the dashboard shows a yellow "is this you?" line with **Allow / Dismiss**. I set it up via `propose_channel`, `request_secret`, `channels_list`. Key requests via Telegram arrive as a one-time link (needs `PUBLIC_URL`; works once, 10 min, one value).
Quiet by default: answers and what needs the person; `/progress on|off` toggles live notes. **Quoting** a message addresses the task that wrote it; a plain one continues the active task. `/agents` lists them; `/pm text` or `@pm text` writes to one. `/done`, `/continue [text]` (dashboard: ▶ Continue), `/discuss pm architect: topic`.

## Schedules

Settings → **Schedules**: time ("every day at 09:30", weekdays, days, every N hours, raw cron), time zone, quiet hours, action: **post a message** (free) or **start a task** (budget; updates go to that chat). Buttons: Run now, Turn on/off, Edit, Delete. Missed runs are skipped. I manage them (`propose_schedule`, `schedules_list`).

## Approvals

A risky action stops with a card: **Approve** / **Deny**; **Options**: "Don't ask again for this exact call in this task" or "…anywhere (global, expires after 30 days)" (MCP tools: same arguments only). My batches are ONE card, applied in order; my cards have no "don't ask again". Server `.env` guard rails: `AGENT_IDLE_TIMEOUT_MS` aborts a silent run; `BUDGET_TOKENS_PER_TASK`/`_PER_DAY` block a task. Approvals time out (deny) per Settings → General → Approvals.

## Questions from agents

`ask_user`: a card with **answer buttons** (one or several) in the dock bottom right and in Telegram (tap, text or number); first answer wins; none in 1 h → the agent chooses or reports blocked. In Telegram a task blocked on the person becomes the chat's active one: the next plain reply answers it. Blocked/stalled questions escalate to the parent lead or the default channel (Settings → Escalations). `docs/questions.md`.

## Camera, video, pictures

Text files attached to my chat reach me in the prompt; other attachments I read with `read_document`. 📎 menu: **📷 Camera** (HTTPS; else the phone's camera app); videos ≤95 MB (Cloudflare) in tasks, ≤300 MB in Resources. `look_at` (photo or video frames) and `video_digest` (frames + transcript) take `every_seconds`, `at_seconds`, `pointing` / `phrases`. `show_images` shows pictures in the chat (Telegram: photo/album). `docs/media.md`.

## Discussion between agents

**💬 Discuss** (New task form, or a chat's header/⋯ menu): topic, 2–6 agents, rounds, who concludes; Telegram `/discuss pm architect: topic`. Agents answer in turn (short, read-only); the person can join; **Wrap up** → conclusion; **Stop**. *Language of the agents*: *Terse English* (default; 🌐 translate under a message) or *Your language*.

## Languages

Dashboard text is English; the person's text, names, knowledge bases, voice (50 languages) and "done"/"готово"/"完成" can be in any language. Agents talk terse English; the person gets answers in their own. `docs/languages.md`.

## Browser through a proxy

MCP server `playwright-proxy` sends ALL traffic through the operator's proxy (server-only: `PLAYWRIGHT_PROXY_SERVER` host:port, `_USER`, `_PASS` in `.env`, then `docker compose --profile proxy up -d playwright-mcp-proxy`; add it to the agent's MCP list). `docs/browser-proxy.md`.

## How-tos

**Provider with an API key.** Settings → Providers → **+ Add provider** → *Kind*, *Name*, *Default model* (**Load models**), *Auth mode*, key in *Secret* → save → **Test**. Write-only key. I pre-fill (`propose_provider`) and show a secure card (`request_secret`).
**Local models (Ollama).** Kind *ollama*, *Base URL* (e.g. http://host.docker.internal:11434), no key; pick a model with tool-call support (Test reports it).
**ChatGPT subscription (Codex).** Kind *codex*, Auth mode *codex-login*, model e.g. gpt-6.1-sol; once on the server: Docker `docker compose exec -it -e CODEX_HOME=/workspace/secrets/codex orchestrator codex login --device-auth`; bare-metal `CODEX_HOME=<data dir>/secrets/codex codex login --device-auth`; open the link, enter the code, **Test**. Such agents use the Codex runtime.
**Default provider** (the admin chat uses it): Settings → Providers → *Default provider*, or `makeDefault`. **Agent model:** Agents → Edit → *Provider*/*Model* (also for admin; a weak/local model may fumble tools).
**Repository.** Settings → General → Repository: *Repo URL* (save), *GitHub token*, *Base branch*. **Checks after each run:** Verification gate, one command per line.
**Disk.** Run folders are removed after 14 days (`RUNS_RETENTION_DAYS`, 0 = never); old worktrees only on request (ask me for a cleanup, or `CLEANUP_WORKTREES=true` + `WORKTREE_RETENTION_DAYS`).
**Official-source research (laws).** Agent from the **researcher** template; built-in `research` MCP. `fetch` works for official domains (EU, UA, UK, US; list in `agent/research.json`); `search` needs `BRAVE_API_KEY=…` or `RESEARCH_SEARXNG_URL=…` in server `.env` (restart). No PDFs yet.

## What I can and can't do

Through approvals: agents, task cleanup, providers (not secrets), tasks for agents, notes, channels, schedules, packs, updates, access. I can't press buttons, change other settings, see keys or create knowledge bases; I point to the place above.
