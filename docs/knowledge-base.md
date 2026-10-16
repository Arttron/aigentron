# Knowledge bases

Large reference material that agents **search** instead of carrying in the prompt: regulations, manuals, textbooks, saved web pages, your own notes. (Short facts and photos every agent should always see belong in the **Resources** library — `docs/resources.md`.)

## How it works
1. **Dashboard → 🧠 Knowledge → + New base.** Name, one-line description (agents read it to decide when to search), which agents use it (none ticked = all).
2. **Add documents** — upload PDF (text layer), Word (.docx), Markdown, text, HTML, CSV; write a note; pick something from Resources; or pull in the web pages the research tools saved (`agent/research-cache`). The same text is never added twice. Adding is **asynchronous**: the request is answered at once (`202 {id, status: "processing"}`) and the file is read, cut and stored in the background, one document at a time — a big PDF no longer holds the request longer than a web proxy waits. The list on the page shows the document as *processing* until it is *ready* (it refreshes by itself), or *failed* with the reason (a scan without a text layer, a damaged file, the same text already in the base); a failed row stays for 6 hours or until you dismiss it (✕). In-flight work lives in memory: if the server restarts while a document is processing, add it again.
3. Each document is **cut into passages** by the base's settings (below) and stored in the app's own database (Postgres or SQLite — nothing to install).
4. Agents get the tools `kb_list`, `kb_search {query, kb?, limit?}`, `kb_read {doc, chunk?}` and, if the base allows it, `kb_add {kb, title, text, source?}`. The prompt names the bases an agent may use, never their content. Results carry the document, passage number and **source** so the agent can cite.

## Search
- **Keyword (BM25)** always works — offline, no key. Words are lower-cased and lightly stemmed (English endings; Cyrillic and Greek by a fixed-length stem), headings count double. Any script works (`docs/languages.md`); write the query in the language of the documents. A passage in a result is shown up to 700 characters (`kb_read` gives the whole).
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
- 20 MB per file, 5 M characters per document, 20 000 passages per base (the index lives in memory — a bigger corpus needs an external store, see the plan); scans (PDF without text) need OCR, which is not available yet.
- Who manages bases: operator and admin; agents only search/read (and add notes to bases where "agents may add notes" is on).
- The index lives in memory per base and is rebuilt after a change; it is built page by page without freezing the server (a few seconds for ~10 000 passages) and patched in place while embeddings are being made.
- API: `GET/POST /api/knowledge`, `GET/PATCH/DELETE /api/knowledge/:name`, `…/docs` (each row carries `status: processing | ready | error` and, for a failure, `error`), `…/docs/upload` (raw body + `x-filename`), `…/docs/note` and `…/import/resource` (all three answer `202 {id, status: "processing"}` at once — `docId/chunks/duplicate` are kept for older clients), `DELETE /api/knowledge/docs/:docId` (also dismisses a failed import), `…/import/research` (synchronous, returns counts), `…/search`, `…/reembed`, `POST /api/knowledge/preview`. Managing routes need operator/admin; search also reviewer and task setter.

## Notes on safety and limits
- Passages returned to agents are fenced as quoted data (`<passage>`), with a one-line reminder that they are not instructions. An agent with no known identity sees only bases open to everyone.
- PDFs: at most 600 pages and 60 s to read; Word files: refused when the declared unpacked size is huge. Notes and previews arrive as JSON (limit 3 MB).
- Embeddings use at most the first 8 000 characters of a passage (models such as nomic-embed-text cut at ~2 000 tokens anyway); keyword search always sees the whole passage.
- Chinese / Japanese / Korean text is indexed as character pairs.

## Not (yet) included
OCR for scans, connecting an external database (the design is in `docs/plan-knowledge-base.md`), `verify_quote` over knowledge-base documents, admin-agent tools to create/bind bases (the admin guides you through the dashboard instead).
