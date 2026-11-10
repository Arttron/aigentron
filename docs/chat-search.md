# Search in chats — plan

Status: BUILT (phases 0–3, 2026-11-10); phases 4–5 open. Decisions: round-table discussions count as chats; "Mine" = messages people wrote (in tasks I created: messages carry no author yet); no `/search` in Telegram or the extension for now. As built: no `transcript/around` API (the transcript is not paged, so a deep link is `?ev=<session>:<seq>` and the page scrolls to the line); the in-conversation find is client-side (browser highlight registry); the task list shows an "Also in conversations" strip under its search box instead of a scope switch; Cyrillic and Greek words are cut to 4 letters in the index so «Литва / Литве / Литвы» meet (the knowledge base cuts to 5). Mockups: the private "Chat search mockups" canvas (https://claude.ai/artifact/12Fm9T3ypx8kqzUMg2Kcsy).

## What is a "chat" here
Every conversation is a task's event stream (`AgentEvent`: `prompt` = what a person wrote, `assistant`, `result`, `discussion` with a `speaker`, plus tool / stderr noise). The admin assistant, Telegram messages and the extension's chat are tasks too, so ONE index over `AgentEvent` covers all of them. Queued follow-ups (`PendingFollowUp`) are not indexed (they enter the stream when they start).

Today: the task list searches only a task's title / first prompt (`contains`, `TasksService.list`). Nothing finds what was said later in a conversation.

## Pattern search (added after the first build)
The ".* Pattern" chip on the Search page (`mode=pattern` in the API) treats the text as a regular expression, case-insensitive and Unicode (`\w`, `\W`, `\b`, `\B` are rewritten to mean letters and digits of ANY script — in JavaScript they are ASCII-only, so «лит\w+» would never match «Литве»). It cannot use the word index: the latest 20 000 messages that pass the filters (scope, project, agent, status, date) are read and scanned in a worker thread that is killed after 4 s (a pattern like `(a+)+$` must not stop the server; the page says so), a pattern is at most 200 characters, a message is scanned up to 20 000 characters, at most 20 matches per message; an invalid pattern is a 400 with the reason. The answer says when it read only the latest N messages. Not offered to the admin tool (`chats_search`) or the Ctrl/Cmd+K palette.

## Goal and non-goals
- Find a message by words I remember, in any language, across all tasks I may see, and jump to it in its conversation.
- Not: semantic / "what did we decide" search (phase 5, optional), searching files or knowledge bases (that is `kb_search`), searching tool output by default.
- Cost: zero model tokens. Fast on the minimal single-container profile as well as the full stack.

## What the person sees (mockups)
1. **Search page** (main menu → Search): one box, scope chips (All / Mine / Agents / Results only), filters (project, agent, status, date, include tool output), results grouped by task with up to 3 snippets, the matched words marked, sort best match / newest. Clicking a snippet opens the task AT that message.
2. **Quick search** (Ctrl/Cmd+K): a palette with the top message hits and task titles; Enter opens at the message, Shift+Enter the full page.
3. **Find in a conversation**: a bar inside the task page, "2 of 3", next / previous, highlights; also finds messages that are not loaded yet (the transcript is paged).
4. **Task list**: the existing box gets a "Titles and messages" scope; rows show the matching snippet.
5. **Phone**: the same page, filters in a sheet.
6. **States**: nothing found (with ways to loosen the query), the index still being built after the update, hits hidden by permissions.
7. **Admin assistant**: `chats_search` tool (read-only) so "what did we decide about X?" can be answered from history.

## Design
### Matching
Reuse the knowledge base's language-agnostic tokenizer (`knowledge/kb-core.ts`: lowercase, NFKC, stems for en / ru / other Latin, character pairs for CJK) — "Литве / Литвы / Литва" meet, any language works (see the language policy). Quotes = exact phrase (verified against the original text), `-word` excludes, plain words are AND.

### Storage — one implementation per database, one interface (`ChatSearchStore`)
- New column `AgentEvent.searchText` = the event's tokens (stemmed, space-separated), written when the event is saved, only for kinds `prompt | assistant | result | discussion` (tool output optional, a separate kind flag).
- Postgres: GIN index on `to_tsvector('simple', searchText)`; query `to_tsquery('simple', …)`, `ts_rank_cd`.
- SQLite (minimal profile): FTS5 virtual table over `searchText` (external-content), `bm25()`.
- Because the tokens are produced by our code, both databases rank the same words the same way; the database only does the lookup.
- Backfill: a background job indexes old events in batches (progress shown in the "building the index" state), resumable, low priority (waits while the machine is busy, like other maintenance).
- Migrations in both `prisma/migrations` and `prisma/sqlite/migrations`.

### Ranking
Database rank, times a recency factor (half-life ~60 days), plus a bonus for hits in `prompt` (what the person wrote) and in the task title. Results are grouped by task: task score = best event + a little for the number of hits.

### API
`GET /api/search/chats?q=&scope=&project=&agent=&status=&from=&to=&tools=&cursor=` → `{ tasks: [{ taskId, title, status, project, agent, updatedAt, hits: [{ eventId, kind, speaker, at, snippet, marks }] }], total, indexed: 0..1 }`. Snippets are cut from the ORIGINAL text around the first matches (not from tokens). `GET /api/tasks/:id/transcript/around?event=` returns a window of the stream around an event for deep links (`/tasks/:id#ev=<id>`). `GET /api/tasks/:id/find?q=` for the in-conversation bar (event ids in order).

### Permissions
Results are filtered by the same project / task access rules as the task list, inside the query (never post-filtered after counting): a result must not reveal a title, a snippet or even a count of a chat the person cannot open (mockup 6). Admin-chat events are only for users who may use the admin chat.

### Privacy and safety
No secrets are indexed beyond what is already in the transcript (the transcript stores no secret fields: `request_secret` input goes to the secure field). Deleting a task deletes its events and its index rows (cascade). A setting "Index tool output" is off by default.

## Phases
| # | Scope | Size |
|---|---|---|
| 0 | `searchText` + indexing on write + Postgres and SQLite stores + backfill job + `GET /api/search/chats` + tests (tokenizer parity, permission filter, phrase / exclude, both DBs) | M |
| 1 | Search page (desktop + phone), scope chips and filters, grouped results; main-menu entry | M |
| 2 | Deep link: transcript window around an event, scroll + flash; in-conversation find bar | M |
| 3 | Quick search palette (Ctrl/Cmd+K) and the task-list scope; admin tool `chats_search` + admin docs (`make check-admin-skills`) | S |
| 4 | Saved searches, "include tool output", export of results | S |
| 5 | Optional semantic ranking with the knowledge base's embeddings (only when a model is configured) | L |

## Risks and open questions
- Index size: roughly the size of the message text again (a few MB per 10k events); tool output excluded keeps it small. Measure on a big real database before phase 1.
- Write path: tokenizing on every event adds a little CPU to streaming; do it on the final text of a message, not on partial deltas.
- Old events edited? Events are append-only; the only rewrite is deletion with the task.
- Questions for the product owner: (a) do round-table discussions count as chats (proposed: yes); (b) should the extension's panel and Telegram get `/search` (proposed: later, phase 3+); (c) is "Mine" = messages I wrote, or tasks I created (proposed: messages I wrote).
