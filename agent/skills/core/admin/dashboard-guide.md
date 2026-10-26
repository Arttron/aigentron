---
description: Map of the dashboard — pages, tabs, forms, buttons, and click-by-click how-tos (providers, agents, repo, approvals, tasks, chat, knowledge, disk).
---
# Dashboard guide

Tell the user EXACTLY where to click, with the real labels below. Never invent menu items.

## Layout

- **Main page (`/`)** header: user switcher, connection indicator, links **🧑‍💻 Agents**, **📚 Resources**, **🧠 Knowledge**, **📁 Workspace**, **📁 Projects**, **🧩 Add-ons**, **📊 Stats**, **⚙ Settings**. Then the **New task** form (prompt, agent picker — first option = default lead, 📎 attachments incl. **📷 Camera**, references to earlier tasks, **💬 Discuss**) and the task list (search, pages, filters).
- Bottom-left: theme toggle. Bottom-right: the mascot — click to open this chat; approval cards and agent questions appear next to it on every page.
- **Task page (`/tasks/<id>`)**: transcript, pending approvals, follow-up box, Cancel/Delete, attachments, PR/branch links, subtasks, **✅ Mark as done**, **💬 Discuss** (finished tasks).

## Task list

- **Status chips** (counts; empty hidden): *Needs attention* (approval, blocked, stalled, failed), *Active* (queued/running), *Ready*, *Done*, *Blocked*, *Approval*, *Failed*, *Stalled*, *Cancelled*. A status filter looks at every level (a blocked subtask under a finished parent is listed flat).
- **Type chips** ("Type:"): *Tasks* (started in the dashboard), *Chats* (with a chat agent such as me), *From chats* (Telegram), *Scheduled*, *Discussions*, *Subtasks* (listed flat). The choice is remembered and in the URL (`/?type=chat`).
- A task's conversation fills the screen: the expand icon in the conversation's bottom-right corner (on a phone it also hides the header and tabs; Esc exits).
- New tasks get a short title from a small model (Settings → Task titles); set titles never change.
- **📁 Project** selector at the top (with 2+ projects) is the page's context: the list, its counts and the new-task form belong to the chosen project (**All projects** = everything; the form then has its own project picker). A status filter lists main tasks whose own status or a subtask's matches.
- The list shows only main tasks, each with "3 subtasks · 2 done · 1 running" (on its page; a running subtask makes an idle task show running). Every row has a checkbox on the left (Shift-click selects a range; the box above the list ticks the page); the bar above the list is always there and its buttons — Mark as done / Cancel / Delete — switch on once something is ticked.

## Statuses: who sets "done"

**done** is set only by a person. An agent that finishes makes the task **ready — confirm** (`review`). The person says **"done"** / **"готово"** (a short message; longer text is a follow-up), presses **✅ Mark as done** (task header; Telegram: write "done") or sends `/done`. Else it continues. Blocked / stalled / failed can be accepted as is. Subtasks are accepted by their lead. Chip *Done* = confirmed by a person; *Ready* = waiting.

## Subtasks

In a lead's conversation each subtask's report shows as a message from that subtask's agent (`designer>`, not `you>`), folded to ten lines with **Show more**. Leads call `check_subtasks` and reuse an existing subtask; max 25 per task. New work from inside a task is a **subtask**. A lead closes a handled one with `complete_subtask`.

## The chat window (task page, this admin chat)

- Bar toggles: **terminal** (monospace, prompt-style, follows light/dark; 8-bit palette, stepped pixels) / **classic**, and **all steps** / **messages only** ("N step(s) hidden"). Per browser, remembered.
- **Ambient strip** under the chat: an activity light, decoration only. A small **copy icon** sits under every message (here too).
- While running, a line shows the work; after **30 s** of silence: "⏳ No reply from the agent for N s — it may still be thinking…" (an **Ollama** agent adds that a local model can take minutes for the first reply).
- Photo/video: click opens the viewer; **Ask about this moment** / **Mark and ask** freezes the frame, the person draws a rectangle and sends it as a follow-up.

## Console

Same assistant in a terminal: **`aigentron-admin`** (shell; dev compose: `make admin`). Resumes the last chat (`/new`, `/help`); cards as text — **a** approve, **d** deny, **v** view; keys via a **hidden prompt**. One-shot: `aigentron-admin "question"`.

## Sign-in

Settings → **Security** sets the first password (banner until set); Settings → **Users** → 🔑 gives others theirs. Login: name + password. I can't set/read passwords. Forgotten: another operator resets it in Users, or `make reset-password` on the server (removes all). `docs/authentication.md`.

## Agents page (`/agents`)

Tabs **Agents** and **Starter packs** (`/agents?tab=packs`). Agents tab starts with *Default lead agent* (saved on choice). List with **Edit** (**Delete agent** is inside the Edit dialog) (built-in admin: "built-in" badge, only routing — provider/model — editable). **+ New agent** / **Edit** dialog: **Start from a template** pre-fills; fields: name, description, provider, fallback providers, model, skills, allowed/disallowed tools, MCP servers, instructions. I can do it via approvals.
**Starter packs**: *English learning*, *Home renovation*, *Software team*. **Install** adds agents, a skill, notes and schedules (**off**); never overwrites. I can do it (`propose_pack_install`).

## 📚 Resources (`/resources`)

Notes, images, PDFs, files; agents see the list (title, description, tags) in their prompt and read what is relevant — a clear description matters most. Upload (≤25 MB each, 500 MB total; videos ≤300 MB) or write a note; tags; optionally limit to chosen agents. **Scope** (2+ projects): global = all agents, project = its agents only. Agents never edit them; I change text notes (`propose_resource`) and search (`resources_search`).

## 🧠 Knowledge (`/knowledge`)

Large reference material agents search instead of carrying in the prompt. **+ New base** (name, one-line description, which agents; none = all); upload PDF / Word / Markdown / text / HTML / CSV, add a note, pick from Resources, or pull in saved web pages. Keyword search (BM25); an embedding provider in the base's settings adds meaning search. Agents use `kb_list`/`kb_search`/`kb_read` (`kb_add` if allowed). I can't create bases — guide the person.

## 📁 Workspace (`/workspace`)

Shared folder for non-code work: `WORKSPACE.md` (the brief, edited with ✎; every agent reads it), `memory/` (decisions, open questions, facts, plan, status — agents write with `workspace_note`), `work/` (drafts, data; upload here), `deliverables/` (results from `workspace_save`, versions kept). A **Project** picker switches to a project's own folder (brief `PROJECT.md`). Browse, preview, download, delete; `..` goes up, **Upload**.

## 📁 Projects (`/projects`)

Many projects: each has its own repo (access Public/Token/SSH key, **Test connection**, **Sync now**), checks, default agent, notify channel (a chat — or, with the chat id empty, a whole channel — set as a project's notify chat is bound to it and works only with that project: its tasks, new tasks, replies, escalations; the admin there is that project's assistant only), mode shared/worktree; Settings → Repository = the Default one. Task form/list get a project picker at 2+. I can't enter tokens — guide.

A person who wants to edit and test the code on the server: `docs/work-on-server.md` — own clone (safest) or the project's checkout; a project they work in must be on **worktree** isolation, not `shared` (shared runs the agent in that folder and pushes its current branch).

## 🧩 Add-ons (`/addons`, tabs **Browser** and **Playwright**; the old `/browser` redirects)

**Browser** tab: a real browser on the server (add-on). Not installed → the page shows its needs and the SSH command `sudo aigentron addon enable browser` (Docker: `--backend docker`) with copy buttons; I can't install it. Running → the live screen in the page (operator/admin; few viewers, 2 h per session; **Open in a new tab**, **Fullscreen**). Not answering → `aigentron addon logs browser`. Agents share it: its sign-ins are visible to them. **Playwright** tab: the agents' own headless browser (`playwright` MCP server) on a server without Docker compose; not installed → shows `sudo aigentron addon enable playwright` (Docker: `docker compose --profile mcp up -d playwright-mcp`); nothing to watch. `docs/addons.md`.

## Stats (`/stats`)

Tokens, requests, cost (Codex "—"); Today/7/30 days/all. Three views: **By provider** (with the stacked chart), **By project** (click a project to see it by provider), **By day** (columns per day, your time zone). A **Project** selector (2+ projects) limits the numbers to one project; the **Show:** tick boxes switch the columns off — Sessions, Requests, Input, Output, Cache, Est. cost (remembered in that browser; the charts follow the token ones).

## Settings, channels, schedules, languages, proxy

See the skill **settings-guide** (Settings tabs, Channels, Schedules, Approvals, Questions, Camera, Discussion, Languages, Browser through a proxy).

## How-tos

**Provider with an API key.** Settings → Providers → **+ Add provider** → *Kind*, *Name*, *Default model* (**Load models**), *Auth mode*, key in *Secret* → save → **Test**. Write-only key. I pre-fill (`propose_provider`) and show a secure card (`request_secret`).
**Local models (Ollama).** Kind *ollama*, *Base URL* (e.g. http://host.docker.internal:11434), no key; pick a model with tool-call support (Test reports it).
**ChatGPT subscription (Codex).** Kind *codex*, Auth mode *codex-login*, model e.g. gpt-6.1-sol; once on the server: Docker `docker compose exec -it -e CODEX_HOME=/workspace/secrets/codex orchestrator codex login --device-auth`; bare-metal `CODEX_HOME=<data dir>/secrets/codex codex login --device-auth`; open the link, enter the code, **Test**. Such agents use the Codex runtime.
**Default provider** (the admin chat uses it): Settings → Providers → *Default provider*, or `makeDefault`. **Agent model:** Agents → Edit → *Provider*/*Model* (also for admin; a weak/local model may fumble tools).
**Repository.** Settings → Work → Repository: *Repo URL* (save), *GitHub token*, *Base branch*. **Checks after each run:** Verification gate, one command per line.
**Disk.** Run folders are removed after 14 days (`RUNS_RETENTION_DAYS`, 0 = never); old worktrees only on request (ask me for a cleanup, or `CLEANUP_WORKTREES=true` + `WORKTREE_RETENTION_DAYS`).
**Official-source research (laws).** Agent from the **researcher** template; built-in `research` MCP. `fetch` works for official domains (EU, UA, UK, US; list in `agent/research.json`); `search` needs `BRAVE_API_KEY=…` or `RESEARCH_SEARXNG_URL=…` in server `.env` (restart). No PDFs yet.

## What I can and can't do

Through approvals: agents, task cleanup, providers (not secrets), tasks for agents, notes, channels, schedules, packs, updates, access. I can't press buttons, change other settings, see keys or create knowledge bases; I point to the place above.
- **Opening documents**: a task's md / html / csv / json / txt / pdf attachment (chat chip, Attachments tile, 📎 link) opens in a viewer in the page: Markdown rendered, html in a sandbox (no scripts), csv as a table, **Source** / **Copy** / **Download**.
