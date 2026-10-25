---
description: The Settings pages and what hangs off them - tabs, channels (Telegram), schedules, approvals, questions, camera / video, discussions, languages, browser through a proxy - click-by-click.
---
# Settings guide

Tell the user EXACTLY where to click, with the real labels below. Never invent menu items. (The rest of the dashboard: skill **dashboard-guide**.)

## Settings (`/settings`) — tabs

General, Providers, LiteLLM, MCP servers, MCP endpoint, Channels, Schedules, Voice, Vision, Users, Signed-in devices.

**General** (cards, top to bottom):
- *Version & updates*: **Check now**, **Update to X** (operator confirms; restart 1–2 min; previous kept for `aigentron rollback`; Docker can't self-update: `aigentron update`). I can start it (`propose_update`).
- *Disk & cleanup*: free-space bar, what takes it, **Free up space now** (regenerable caches only). Checked every 10 min: low = banner + message to the default chat; critical = auto-clear. Attachments never auto-deleted.
- *Security* (passwords), *Access* (allowed domains, empty = any; `localhost`/IPs always work unless **Only these domains**), *Web server* (port 80 optional; PEM cert + key → HTTPS on 443; `aigentron access`), *Cloudflare Access* (team domain + AUD, Save, **Test**; requests on real domains without Cloudflare's token are refused; localhost/IP/LAN exempt). I handle domains and Cloudflare via `access_status`, `propose_allowed_domains`, `propose_cloudflare_access`.
- *Approvals*: **No approvals mode** (admin only) = the global level; a project (its settings) and a task (🛡 selector, subtasks follow) can override it, most specific wins. Off: no cards (step/time limits go on alone), except credentials/charter files and admin changes.
- *Run limits*: first time window, extension while still working, quiet limit, steps per run, and at the ceiling a card asks whether a working run may go on (+N min). Env vars are defaults.
- *Task titles* (see above).
- Then: *Repository (GitHub)* (*Repo URL* blank = local workspace; *Base branch*; *GitHub token*; *Project subdirectory* = RELATIVE folder like `apps/web`, a URL is rejected); *Escalations* (default channel + chat/thread for questions from tasks with no channel); *Agent instructions (skill)* appended to every prompt; *Verification gate* (commands per line after each run + max auto-fix attempts); *Task queue* (concurrency); *Approvals* (timeout, s); *Display*.

**Providers**: **+ Add provider**, **Default provider**, rows: **Test**, **Edit** (**Delete provider** is in that dialog). Codex / Claude-oauth: **Sign in**. Form: *Name*, *Kind*, *Base URL*, *Auth mode*, *Secret*, *Default model* (**Load models**), *Rate limits*.
**LiteLLM**: model routes of the gateway (advanced).
**MCP servers**: built-in playwright, **playwright-proxy**, github, postgres, code-intel, **research**. Add: paste whatever the server's page gives — `{"mcpServers": {…}}` (Claude Desktop / Cursor / LM Studio / `.mcp.json`), one `{url, headers}` or `{command, args}` object, a `claude mcp add …` command or a URL; the page shows what it understood (the missing `type` is filled in; the name is taken from the text), **Add**. `"readOnlyTools": ["*"]` (or names) marks tools read-only (no approvals); `"trustAnnotations": true` + **Discover tools**: server-annotated read-only tools skip approvals. Agents use a server only if in their `mcp:`. I can't change MCP servers.
**MCP endpoint**: outside clients (Claude Desktop) drive the platform. **Users**: people, roles. **Signed-in devices**: own sessions (operator/admin: all), **Sign out** per device / "my other devices" / "X everywhere".
**Voice**: speech-to-text (🎤) and text-to-speech (🔊); each a switch, *Provider* (kind OpenAI: OpenAI, Groq, local Whisper/TTS by Base URL), *Model*, *Language*/*Voice*, **Test**. Telegram `/voice on|off`; dashboard 🔊 and **🎙 Voice mode**. Cloud providers receive audio/text. Mic needs HTTPS/localhost. Needs a provider key: guide the user.
**Vision**: provider + model that describe photos/video frames (not Claude/Codex sign-ins; **Test** saves first). Without it `look_at` falls back to the agent's own cloud model. `docs/media.md`.
I can change only: default agent, verification gate, concurrency, approval timeout, agent instructions, branch, subdirectory — never repo URL/tokens — and revert my own changes.

## Channels (Telegram)

Settings → **Channels** (**+ Add channel**): needs a bot (@BotFather) and its token (secure field, never chat). Only allow-listed chats work. A message from a non-allowed chat gets its id back and the dashboard shows a yellow "is this you?" line with **Allow / Dismiss**. I set it up via `propose_channel`, `request_secret`, `channels_list`. Key requests via Telegram arrive as a one-time link (needs `PUBLIC_URL`; works once, 10 min, one value).
Quiet by default: answers and what needs the person; `/progress on|off` toggles live notes. **Quoting** a message addresses the task that wrote it; a plain one continues the active task. `/agents` lists them; `/pm text` or `@pm text` writes to one. `/done`, `/continue [text]` (dashboard: ▶ Continue), `/discuss pm architect: topic`.

## Schedules

Settings → **Schedules**: time ("every day at 09:30", weekdays, days, every N hours, raw cron), time zone, quiet hours, action: **post a message** (free) or **start a task** (budget; updates go to that chat). Task schedules also have **Approvals for this schedule's tasks** (follow the project / No approvals / Ask): nobody is there to answer a card at 03:00, so a job that sends a chart and deletes it should be set to *No approvals* (credentials and platform changes are still asked). Buttons: Run now, Turn on/off, Edit, Delete. Missed runs are skipped. I manage them (`propose_schedule`, `schedules_list`).

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

## Moving to another server

I cannot do it for you (it is two commands on the servers over SSH): `sudo aigentron export` on the old one, `sudo aigentron import <archive>` on the new one (same or newer version, same data folder). It carries the database, secrets, agents/skills/resources, every project's folder and the code; not the add-ons or the browser profile. Then stop the old server (Telegram bot!), re-enable add-ons, check domains. `docs/moving-servers.md`.
