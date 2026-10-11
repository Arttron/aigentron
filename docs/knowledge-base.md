# Knowledge bases

Large reference material that agents **search** instead of carrying in the prompt: regulations, manuals, textbooks, saved web pages, your own notes. (Short facts and photos every agent should always see belong in the **Resources** library — `docs/resources.md`.)

## How it works
1. **Dashboard → 🧠 Knowledge → + New base.** Name, one-line description (agents read it to decide when to search), which agents use it (none ticked = all).
2. **Add documents** — upload PDF (text layer), Word (.docx), Markdown, text, HTML, CSV; write a note; pick something from Resources; or pull in the web pages the research tools saved (`agent/research-cache`). The same text is never added twice.
3. Each document is **cut into passages** by the base's settings (below) and stored in the app's own database (Postgres or SQLite — nothing to install).
4. Agents get the tools `kb_list`, `kb_search {query, kb?, limit?}`, `kb_read {doc, chunk?}` and, if the base allows it, `kb_add {kb, title, text, source?}`. The prompt names the bases an agent may use, never their content. Results carry the document, passage number and **source** so the agent can cite.

## Search
- **Keyword (BM25)** always works — offline, no key. Words are lower-cased and lightly stemmed (English and Russian), headings count double.
- **By meaning (optional):** give the base an embedding provider (OpenAI-compatible or local Ollama; default model `text-embedding-3-small` / `nomic-embed-text`). Passages get vectors in the background and every search fuses the keyword and meaning rankings (reciprocal-rank fusion) — "floor base" finds "screed". It costs a few cents per million words and the text goes to that provider. Changing the model drops the old vectors and re-indexes. If the provider is down, search falls back to keywords with a note.
- The Knowledge page has a search box that behaves like an agent's `kb_search`.

## Cutting documents (per base)
| Strategy | Splits on | Good for |
|---|---|---|
| **section** (default) | Markdown headings and numbered clauses (`1.`, `1.2.3`, `Article 4`, `п. 5.2`, `Статья 4`); the heading path stays with each passage | regulations, codes, manuals |
| **paragraph** | blank lines, small paragraphs merged up to the max size | prose, articles |
| **chars** | fixed windows snapped to sentence ends | logs, OCR text, unstructured |
Settings: max size (default 3000 characters), overlap (200), merge pieces shorter than (200 — only inside one section). The settings dialog has a **preview**: paste a sample and see how it would be cut. New settings apply to documents added afterwards; to re-cut one, remove and add it again (the original files are not kept — only the passages).

## Limits and notes
- 20 MB per file, 5 M characters per document, 60 000 passages per base; scans (PDF without text) need OCR, which is not available yet.
- Who manages bases: operator and admin; agents only search/read (and add notes to bases where "agents may add notes" is on).
- The index lives in memory per base and is rebuilt after a change; a base of tens of thousands of passages loads in a moment.
- API: `GET/POST /api/knowledge`, `PATCH/DELETE /api/knowledge/:name`, `…/docs`, `…/docs/upload` (raw body + `x-filename`), `…/docs/note`, `…/import/resource`, `…/import/research`, `…/search`, `POST /api/knowledge/preview`.

## Not (yet) included
OCR for scans, connecting an external database (the design is in `docs/plan-knowledge-base.md`), `verify_quote` over knowledge-base documents, admin-agent tools to create/bind bases (the admin guides you through the dashboard instead).
