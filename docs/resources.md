# Resources — the libraries

A simple knowledge base made of plain files. There is one **global** library (every task of every project sees it) and, per
project, the project's **own** library (`<project dir>/library/`), seen only by the tasks of that project. Providers and MCP
servers stay global; resources and knowledge bases are the two things that can belong to one project.

## What goes in
Text notes (Markdown), images (png/jpg/webp/gif), PDFs, **videos** (mp4/mov/m4v/webm, and mkv/avi/3gp — ≤ 300 MB each, see `docs/media.md`) and any other file (≤ 25 MB each, text notes ≤ 1 MB, ≤ 500 resources, ≤ 2 GB in total).
Typical: house measurements and reference photos, a learner's profile and vocabulary, a style guide, a price list, meeting notes.

## How to add
- **Dashboard → 📚 Resources** — upload (button or drag & drop) or *New note*. Give each item a **one-line description** (what it is and when
  to read it) and a few tags. Optionally tick the agents it is meant for (none ticked = all agents). Pick the **scope**: *Global* or a project;
  an item can be moved later (the project page shows the project's own library).
- **Ask the admin** — it can add or change text notes (`propose_resource`, with an approval card; `project: <slug>` puts the note into that
  project's library) and search the libraries (`resources_search`). Photos and files you upload yourself.
- **Packs** install their starter notes into the global library, or into a project's when `project` is given (`POST /api/packs/:name/install {project}`).

## How agents use it
- The prompt of each agent carries the list: title, description, tags, kind and the file path — the **task's project library first** (marked
  `project`), then the global one; newest first within each, 25 lines in all (the `resources_search` tool finds the rest). A task never sees
  another project's library. A task of the default project sees `<WORKSPACE_DIR>/library` + global.
- The agent reads what is relevant with its normal Read tool (images and PDFs are readable too) and is told to treat the library as the source of
  truth for the project's facts — and never to modify it. The media / `read_document` tools accept paths inside the global library and the task's
  own project folder (where its library lives) — not another project's.
- Agents that cannot read files (the tools-only admin) use `resources_search` instead; its answer has a *scope* column (the project's slug or `global`).

## Where it lives
The global library: `<agent dir>/resources/` — `files/` and `index.json`. In the docker dev stack that is `./agent/resources/` (git-ignored, never
baked into images); in the minimal image and on bare metal it is `<data dir>/agent/resources/`, so it is part of your normal backup (see
`docs/workspace-layout.md`). A project's library: `<PROJECTS_DIR>/<slug>/library/` with the same layout (the default project's:
`<WORKSPACE_DIR>/library/`). Every library has its own limits (500 items, 2 GB) and index; items are addressed by id across all of them.
**Existing installations:** nothing moves — everything that was in `agent/resources` stays global.

## API
`GET /api/resources?project=all|global|<slug>` (default `all`) → `{ items: [{…, project: <slug> | null}], usage }` (`usage` = the one library
asked for; the global one for `all`). `POST /api/resources` (a note) and `POST /api/resources/upload` take `project` in the JSON body / the
`x-project` header (omitted = global). `PUT /api/resources/:id { project: <slug> | null }` moves an item (file and entry; the id stays).
Deleting a project (`DELETE /api/projects/:slug`, `resources: keep | delete`, default keep): its items move into the global library under
`files/<slug>/`, tagged with the slug — or are deleted.
Images, PDFs, playable video (mp4/mov/webm, with byte ranges) and plain text (shown as text/plain) open inline in the dashboard; everything else downloads under its original name (an uploaded `.html`/`.svg` can never run as a page) — the same policy as task attachments and the workspace (`apps/orchestrator/src/files/file-types.ts`).

## Not (yet) included
Semantic search and automatic chunking of large documents — that is the optional *knowledge base* module (`docs/knowledge-base.md`; resources can be imported into a base there), which does not read these files by itself.
