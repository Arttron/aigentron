# Plan: knowledge base with pluggable storage

> Status: **partially implemented — K1 + K4 + part of K5 BUILT (2026-10-12)** — see `docs/knowledge-base.md` (in-app BM25, optional embeddings with hybrid ranking, chunking strategies + preview, PDF/docx ingest, `kb_*` tools, dashboard page). Still open: K2/K3 (external databases, attached mode), OCR, admin `propose_kb` tools, `verify_quote` over KB. Original draft (2026-10-07): Refines §2.3 of docs/plan-domain-packs.md after the owner's requirement:
> **the user must be able to connect any database as a knowledge store — local or remote.**
> Storage is a connection, like Providers and MCP servers; nothing about it is hard-wired.

## 0. Status and module boundary (2026-10-08; updated 2026-10-12)

**Built (2026-10-12) as `apps/orchestrator/src/knowledge`, differently from the sketch below** (user docs: `docs/knowledge-base.md`):
- **Not a flag-gated optional module:** always on, no `KNOWLEDGE_ENABLED`. Tables `KnowledgeBase` / `KnowledgeDoc` / `KnowledgeChunk`
  exist in both the Postgres and SQLite migration trees.
- **Search is in-app BM25** over an in-memory per-base index (not SQLite FTS5 / Postgres FTS), limit 20 000 passages per base;
  optional embeddings (OpenAI-compatible or Ollama) fuse with BM25 by reciprocal-rank fusion; vectors are stored in the chunk row (no pgvector / sqlite-vec).
- **Binding is on the base, not in agent frontmatter:** `KnowledgeBase.agents` (empty = all agents); there is no `kb:` key in agent files.
- **Writes:** `kb_add` works only for bases with "agents may add notes" (`agentWrite`); no approval card.
- **Ingest:** md/txt/html/csv, PDF (text layer), docx, notes, Resources, and the research cache (`agent/research-cache`).
  xlsx and OCR are not there. Raw files are not kept (only passages), so `rawStorage` does not exist; chunking strategies + preview are built.
- Tools: `kb_list`, `kb_search`, `kb_read`, `kb_add`; dashboard page /knowledge; operator and admin manage bases.
- **Still open:** external databases (K2/K3: `postgres`/`sqlite` drivers, attached mode), OCR, xlsx, admin `propose_kb` tools,
  `verify_quote` over KB documents, `rawStorage`, cleaning steps (§4.4).

Original (deferred) module-boundary notes, kept for history:

- **Optional by design.** Own Nest module + own migrations (both the Postgres and SQLite trees), enabled by a flag
  (`KNOWLEDGE_ENABLED`); when off, no tables are created, no `kb_*` tools exist, `kb:` in an agent file is ignored with a
  warning. The minimal profile ships without it unless enabled. *(Not done: the module is always on.)*
- **Existing seams it will plug into** (already in the code, no changes needed in them):
  - the `research` cache (`agent/research-cache/*.json`: `url, finalUrl, title, fetchedAt, lastModified, contentType,
    hash, text`) is the ingest contract — the module scans/watches it and indexes pages as documents with their
    source URL, fetch time and edition date *(built as an import action: `…/import/research`)*;
  - `verify_quote` checks against the cache today and can check against KB documents later (same output);
  - MCP read-only declaration (`readOnlyTools`) lets a KB MCP/HTTP server be trusted without per-call approvals;
  - admin tools pattern (`propose_*` + approval card) for creating/binding bases;
  - reserved names: tools `kb_list`, `kb_search`, `kb_read`, `kb_add`; agent frontmatter key `kb:` *(the key was not used)*.
- **Build order when taken into work:** K1 (builtin driver, FTS, md/txt ingest, `kb_search`/`kb_read`, chunking +
  raw-retention settings, research-cache ingest) → K2 (connect an external DB, UI) → K3 (PDF/docx) → K4 (embeddings).

## 1. Model

`KnowledgeBase` (registry row, CRUD in Settings → Knowledge, like Providers):

| Field | Meaning |
|---|---|
| `name` | unique, referenced by agents (`kb: building-codes, notes`) |
| `driver` | `builtin` (default, uses the app's own DB), `postgres`, `sqlite` (file), later others |
| `url` / `secret` | connection string (masked on read, write-only, same pattern as Provider.secret) |
| `mode` | `managed` — we own the schema and ingest into it; `attached` — read-only over existing tables |
| `rawStorage` | `keep` / `text` / `discard` — see §4.1 |
| `chunking` | strategy + size/overlap parameters — see §4.2 |
| `embedding` | optional: provider + model + dimension used for vectors (recorded so a model change forces a re-index) |
| `readOnly` | forbid writes (`kb_add`, ingest) even for managed stores |

`builtin` needs zero setup (works in the minimal profile with SQLite FTS5 and in full with Postgres FTS).
`postgres` covers local Postgres, Supabase, Neon, RDS — anything that speaks Postgres; pgvector is
**detected**, not assumed (`CREATE EXTENSION vector` available?) and enables semantic search when present.
`sqlite` points at a file (local, portable, can ship inside a pack).

## 2. Driver interface

```ts
interface KbStore {
  init(): Promise<void>;                                   // managed: create schema; attached: validate mapping
  capabilities(): { fullText: boolean; vector: boolean; write: boolean };
  upsert(doc: KbDoc, chunks: KbChunk[]): Promise<void>;    // managed only
  search(query: string, opts: { limit: number; mode: 'text' | 'vector' | 'hybrid' }): Promise<KbHit[]>;
  read(docId: string, chunk?: number): Promise<KbChunk[]>;
  remove(docId: string): Promise<void>;
  stats(): Promise<{ docs: number; chunks: number; bytes?: number }>;
}
```
Every hit carries `source`, `title`, `locator` (page/section) so agents can cite.

**Attached mode** (existing database with its own tables): a small mapping — table, id column, text column,
title/source columns, optional vector column — and we generate the read-only `search`/`read` queries from
it. No arbitrary SQL from agents.

## 3. Agent side

- Tools (in-process, run in the orchestrator, so credentials never reach the agent env):
  `kb_list`, `kb_search(query, kb?)`, `kb_read(docId, chunk?)`, `kb_add(kb, title, text, source?)`.
- An agent sees only the bases listed in its frontmatter `kb:` (default: none), plus the prompt gets one
  line per base (name + description + capabilities), never the content.
- `kb_add` and any write go through the approval gate like other writes to shared data (decision pending).
- Admin agent: can create/attach bases and bind them to agents via approved proposals (same flow as
  `propose_agent`); never sees secrets.

## 4. Ingest and data preparation (configured per knowledge base)

Pipeline: source file/upload -> **extract text** (md/txt first; PDF/docx/xlsx via converters later) ->
**clean** -> **chunk** -> dedupe by content hash -> store (+ optional embeddings). Every step below is a
setting on the base, chosen when it is created, with sensible defaults.

### 4.1 Raw data retention (`rawStorage`)

| Value | Behavior | Trade-off |
|---|---|---|
| `keep` | original file kept (file store or the base's DB) next to the chunks | can re-chunk / re-embed / re-extract later with new settings; costs disk (matters on free DB tiers) |
| `text` | keep only the extracted clean text, drop the original binary (PDF/docx) | can re-chunk, cannot re-extract; much smaller |
| `discard` | keep only chunks | smallest; **changing chunking or embedding model needs a re-upload** |

Default `keep` for local stores, `text` for remote stores with a size quota. The UI states the
consequence of `discard` up front, and every chunk records `docId`, `locator` (page/section), and the
chunking config version that produced it.

### 4.2 Chunking strategy (`chunking`)

| Strategy | Splits on | Good for |
|---|---|---|
| `section` ("by points") | headings and numbered clauses (`1.`, `1.2.3`, `п. 5.2`, `Article 4`, markdown `#`); patterns are configurable | regulations, codes, manuals — each clause stays whole and citable |
| `paragraph` | blank lines; small paragraphs merged up to `maxChars` | prose, articles, textbooks |
| `chars` | fixed window of `size` characters | unstructured text, logs, OCR output |

Common parameters: `maxChars` (hard cap per chunk; oversize sections fall back to `paragraph`, then `chars`),
`overlap` (characters, or percent, repeated between neighbouring chunks — applies to all strategies, mainly
useful for `chars`), `minChars` (merge tiny fragments), `keepHeadingPath` (prepend "Chapter > Section" to each
chunk so a fragment is understandable alone), `splitOnSentence` (when cutting by `chars`, snap to a sentence
boundary instead of mid-word).

Defaults: `section` for documents with detected structure, otherwise `paragraph`, `maxChars ≈ 3500`
(~800 tokens), `overlap ≈ 10%`.

### 4.3 Preview before commit

Because chunking decides retrieval quality, the dashboard shows a **dry run** on a sample file before the
real ingest: chunk count, size distribution, and the first chunks as they will be stored. Changing settings
re-runs the preview; a base can be **re-indexed** with new settings when raw data was kept.

### 4.4 Cleaning (optional steps, off by default)

Strip headers/footers and page numbers, normalize whitespace and hyphenation, drop boilerplate by regex,
detect language per document.

Embeddings stay optional and use any configured provider (local Ollama or API); the base records model +
dimension and refuses mixed vectors.

## 5. Safety

- Connection strings are secrets: write-only in the API, never in agent env or logs. (Provider secrets are
  plaintext in the DB today — a shared encryption-at-rest task would cover both.)
- Remote databases mean data leaves the machine: show it in the UI ("remote: host") when attaching.
- `attached` + `readOnly` by default; enforce read-only at the driver (read-only transaction), not by trust.
- Limit result size and tool-call rate to keep a runaway agent from dumping a whole base.
- Remote free tiers can pause/idle (e.g. Supabase free pauses after a week): `test` on attach, and a
  failing store must degrade to a clear tool error, not a hung run.

## 6. Phases

- **K1 — builtin + driver interface.** *(DONE, without a driver interface and with in-app BM25 instead of FTS)* Schema (docs/chunks + FTS) for Postgres and SQLite, `kb_search`/`kb_read`,
  ingest from md/txt, `KnowledgeBase` registry with `builtin` only.
- **K2 — connect a database.** *(OPEN)* `postgres` and `sqlite` drivers (managed mode), connection test + capability
  detection, Settings → Knowledge UI, `kb:` frontmatter binding.
- **K3 — attached mode** *(OPEN)* with column mapping, read-only enforcement.
- **K4 — embeddings** (pgvector / sqlite-vec) and hybrid search; model/dimension tracking. *(DONE with vectors in the chunk row and hybrid RRF; no pgvector / sqlite-vec)*
- **K5 — converters** (PDF/docx/xlsx), dashboard upload page, admin-agent tools to create/bind bases. *(PARTLY: PDF, docx and the dashboard page done; xlsx, OCR and admin tools open)*

## 7. Open decisions

1. Are writes by agents (`kb_add`) allowed at all in K1, and if so behind approval?
2. Where do `builtin` documents live physically: app DB tables (simple) or a separate SQLite file per base
   (portable, easy to ship in a pack)?
3. Defaults for `rawStorage` per driver (proposed: `keep` local, `text` remote).
4. Attached mode in the first iteration or after managed mode is proven (recommended: after)?
