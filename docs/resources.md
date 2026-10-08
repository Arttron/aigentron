# Project resources — the shared library

A simple knowledge base made of plain files. Everything in it is available to **every agent of the project**.

## What goes in
Text notes (Markdown), images (png/jpg/webp/gif), PDFs and any other file (≤ 25 MB each, ≤ 500 resources, ≤ 500 MB in total).
Typical: house measurements and reference photos, a learner's profile and vocabulary, a style guide, a price list, meeting notes.

## How to add
- **Dashboard → 📚 Resources** — upload (button or drag & drop) or *New note*. Give each item a **one-line description** (what it is and when
  to read it) and a few tags. Optionally tick the agents it is meant for (none ticked = all agents).
- **Ask the admin** — it can add or change text notes (`propose_resource`, with an approval card) and search the library (`resources_search`).
  Photos and files you upload yourself.

## How agents use it
- The prompt of each agent carries the list: title, description, tags, kind and the file path (newest 25; the `resources_search` tool finds the rest).
- The agent reads what is relevant with its normal Read tool (images and PDFs are readable too) and is told to treat the library as the source of
  truth for the project's facts — and never to modify it.
- Agents that cannot read files (the tools-only admin) use `resources_search` instead.

## Where it lives
`<agent dir>/resources/` — `files/` and `index.json`. In the docker dev stack that is `./agent/resources/` (git-ignored, never baked into images);
in the minimal image and on bare metal it is `<data dir>/agent/resources/`, so it is part of your normal backup (see `docs/workspace-layout.md`).
Images and PDFs open inline in the dashboard; everything else downloads (an uploaded `.html` can never run as a page).

## Not (yet) included
Semantic search and automatic chunking of large documents — that is the optional *knowledge base* module (`docs/plan-knowledge-base.md`), which can read these same files later.
