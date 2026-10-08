# Plan: universal project-execution platform (domain packs, knowledge base, tools)

> Status: DRAFT for discussion (2026-10-07). Based on a code + docs review; nothing here is implemented.
> Goal: make Aigentron useful beyond software — construction, language learning, 3D/CAD modeling —
> by extending it with knowledge bases, domain agents and extra tools, without forking the core.
> Constraints that still hold: cheap + local-first, works in the minimal single-container profile
> (SQLite, no Redis/Postgres required), approval gates stay fail-closed.

## 1. Where we are

**Already generic and reusable as-is:** task/status contract (`report_task_status`, blocked, subtasks +
fan-in), approvals, channels (Telegram text + files), attachments in/out, provider routing + failover,
agents (`agent/agents/*.md`) and skills (`agent/skills/**`) as files, MCP registry, `schedule_check`,
learned skills (Phase 6), inbound MCP host, shared-workspace mode without a repo.

**Hard-coupled to software dev:**

| Area | Coupling | Where |
|---|---|---|
| Git worktree per task | hard | `worktrees/worktree.service.ts`, `task-worker.service.ts:86-93` |
| Repo clone / push / PR | hard (best effort, no-repo works) | `workspace.service.ts`, `github.service.ts` |
| System prompt orientation ("worktree", "next dev", "git ls-files") | text, replaceable | `real-agent-executor.ts:935-975` |
| SOUL.md | ~60% generic, ~40% dev | `agent/SOUL.md` |
| Task fields `branch`, `worktreePath`, `prUrl`, `pushedTo` | schema | `prisma/schema.prisma` |
| Dashboard labels (Repo URL, PR, worktree) | cosmetic | `GeneralSettingsForm.tsx`, `TaskDetailPage.tsx` |
| Danger classifier (git push, npm publish; every `mcp__*` gated) | code, not config | `packages/shared/src/classify.ts` |
| Preview server (`npm run dev`, ports 3200-3203) | hard to web dev, optional | `preview.service.ts` |

**Gaps (nothing exists):** knowledge base / retrieval, `Project` entity (one workspace per instance),
pack/plugin concept, system-binary packaging, voice input, user-defined recurring tasks,
config-driven classifier policy, MCP/CLI env passthrough (agent env is an allowlist), attachment cap
(10 MB) too small for CAD/audio.

## 2. Target design

### 2.1 Domain pack
A directory (later: a versioned archive) that bundles everything a domain needs:

```
packs/<domain>/
  pack.yaml            # name, version, description, requires (binaries, mcp), compatible profiles
  SOUL.md              # domain charter overlay (loaded after global SOUL)
  agents/*.md          # domain roles (provider, skills, allowedTools, mcp)
  skills/core/*.md     # domain skills (namespaced <pack>/<name>)
  mcp/*.json           # McpServer definitions (+ read-only tool allowlist for the classifier)
  knowledge/           # seed documents ingested into the KB
  verify.sh            # optional domain validator for the verify gate
```
Install = copy into `agent/` with the same seed-once / three-way-merge mechanism as
`AgentFilesSyncService`; `learned/` stays per pack. Dev stays the built-in default pack.

### 2.2 Project entity
`Project { id, name, domainPack, workspace (path or provider), repo?, defaultAgent, verifyCommands,
mcpSet, SOUL overlay }` and `Task.projectId`. Today everything reads one `WORKSPACE_REPO_PATH` and the
`AppSettings` singleton, so this is the biggest structural change. Until it lands, "one container per
project" works as a workaround.

### 2.3 Knowledge base
No RAG exists; skills are prompt-stuffed (16 KB/file, 64 KB total). Proposal:
- Expose KB as **tools** (`kb_search`, `kb_read`, `kb_add`), via an in-process tool or an MCP server —
  not as more prompt text.
- **Stage 1 (cheap, local, minimal-profile-safe):** SQLite FTS5 / Postgres full-text over chunked
  documents. No embeddings, no extra service.
- **Stage 2 (optional):** embeddings through Ollama on the host, hybrid with FTS.
- Ingest: files under `project/knowledge/` and attachments; PDF/docx/xlsx -> text (a converter CLI).
- Scopes: global, per pack, per project. `learned/` notes can graduate into the KB (human-approved).

### 2.4 Tools
Three mechanisms, in order of preference:
1. **CLI via Bash** + a skill describing it (zero code; needs the binary on PATH and classifier tuning).
2. **MCP server** from the registry (stdio in the image, or a sidecar over SSE/HTTP like `playwright-mcp`).
3. **In-process tool** in `@lds/agent-runner` (only for core primitives like KB; currently a 4-file change
   per tool — add a small registry so packs don't need core edits).

Packaging system binaries (Blender, FreeCAD, ffmpeg, LibreOffice, tesseract): a **tools profile** —
compose sidecars for docker mode and a `requires`-driven installer step for bare-metal. Not baked into
the 3 GB minimal image.

### 2.5 Research tools (regulatory/legal web research) — review notes, 2026-10-08

> **Implemented 2026-10-08 (steps 1, 2, 4):** configurable read-only MCP tools in the classifier (`readOnlyTools` in an MCP server's
> config), the built-in `research` MCP server (`/api/research-mcp`: `sources`, `search`, `fetch`, `verify_quote`; https-only,
> domain allow-list from `agent/research.json`, SSRF-safe DNS, page cache in `agent/research-cache/`) and the `researcher` template.
> **Still open:** step 3 — cache → knowledge-base documents (needs KB K1), per-pack/project allow-lists (no Project entity yet),
> PDF text extraction, search backend not configured by default.

Input: an external review of "search the web on the fly instead of a pre-loaded base" via an MCP server. What applies to us,
checked against the current code:

- **MCP search/fetch is the right shape.** The runtimes' own web tools are not portable (Claude's `WebSearch`/`WebFetch` depend on
  the provider route; Codex has its own) while an MCP server works the same on both runtimes (we serve MCP over stdio/HTTP for
  Codex and via the registry for Claude; SSE-only servers are skipped on Codex). Admin already has web tools disabled.
- **Own tools with a swappable backend** (`search(query, jurisdiction)`, `fetch(url)`; read-only). Backend candidates: self-hosted
  SearXNG (fits local-first, no key) or Brave/Tavily/Exa/Firecrawl (key). The domain **allow-list lives in the tool**, per
  pack/project config — a pack's `sources` (official registries, regulators, EUR-Lex…).
- **Full text, not snippets; edition + date captured; code-checked quotes.** `fetch` returns clean text plus edition/status/date;
  the agent's answer carries URL + clause + verbatim quote; a `verify_quote(url, quote)` step (or an orchestrator check on the
  final report) compares against the cached fetch result. This is the mechanism that makes construction/legal answers citable.
- **Cache = knowledge base.** Every fetched page becomes a KB document (URL, fetched-at, hash, text) — exactly the K1 ingest +
  `rawStorage` model in docs/plan-knowledge-base.md — so answers are reproducible and the base grows by use.
- **Classifier change (needed).** `classify.ts` hard-codes read-only MCP tools per server name (code-intel, github, playwright);
  any other MCP server is gated on every call. Replace with a configurable per-server read-only tool list stored with the
  `McpServer` row / pack manifest (this is the "per-pack allowlist" already listed under risks).
- **Researcher agent = no Bash/Write/Edit** (web pages are untrusted input → prompt injection). Easy with agent files
  (`disallowedTools`); our credential-read gate already blocks the obvious exfiltration targets, but a researcher should also
  have no `WebFetch` outside the allow-list tool.
- **Playwright is not the research tool:** navigation to non-local URLs is intentionally approval-gated (`isLocalNavUrl`).
- **Limit:** statutes/regulations are public; standards (EN/ISO/national) are paid — their text isn't on the web, so those still
  need uploading purchased documents into the KB.

## 3. Phases

**Phase 0 — pilot without code (1-2 days).** Shared mode, no repo. Hand-write one pack's files
(agents + skills + project SOUL + verify script) and run real tasks. Output: a list of what actually
breaks, replacing guesses in this doc. Pick the pilot domain first (see §5).

**Phase 1 — de-IT the core (small changes).**
- Parameterize `buildOrientation` / default `agentInstructions` / reporting prompts by profile.
- Split SOUL.md into core charter + dev overlay.
- Workspace provider interface: `git-worktree` (today) and `plain-dir` (per-task directory, optional git
  for undo/diff); generic `Task.deliverable` instead of `prUrl`/`pushedTo`; non-git project map fallback.
- Classifier: config-driven read-only MCP allowlist per pack; non-dev shell rules stay as the safety net.
- Env passthrough allowlist for MCP/CLI tools; configurable attachment cap; label strings in dashboard.

**Phase 2 — Project entity + pack manifest.** `Project` model, `projectId` on tasks, per-project
settings; `pack.yaml`, install/update/uninstall, namespacing of skills, `requires` check with a clear
"binary missing" error up front (today a missing MCP binary only fails at run time).

**Phase 3 — knowledge base.** FTS stage, ingest pipeline, `kb_*` tools, dashboard page (browse, upload,
re-index), per-scope visibility. Embeddings as a later opt-in.

**Phase 4 — tool packs.** MCP/CLI integrations per domain, sidecar compose profile, bare-metal
installer hooks, preview-render hook replacing the web dev-server preview (Blender render -> PNG as an
attachment).

**Phase 5 — human-in-the-loop and rhythm.** Human agents (RFC-001 phase 3: inspector, tutor, CAD
reviewer, `waiting_human`), Telegram voice -> STT, user-defined recurring tasks (daily lesson,
weekly site report) beyond the 1-hour `schedule_check`.

## 4. Domain sketches (first packs)

**Language learning.** Agents: curriculum planner (lead), tutor, exercise generator, reviewer.
KB: learner profile, vocabulary, grammar notes, textbooks (PDF). Tools: TTS/STT, spaced-repetition
via recurring tasks, Telegram as the main interface (voice in/out). Verify: exercise-format checker.
Lowest risk, best fit for cheap local models; strong candidate for the pilot.

**Modeling / CAD.** Agents: modeler, reviewer, render/QA. Tools: Blender or FreeCAD (MCP or CLI),
render-to-PNG attachments. Verify: script that validates the exported file (manifold, units, bounding
box). Needs the tools profile and a larger attachment cap (3D files).

**Construction.** Agents: estimator, norms/compliance checker, scheduler, human site inspector.
KB: building codes, price lists, project documents; drawings via PDF/vision. Tools: spreadsheet/calc,
document parsing. Verify: totals/units checks. Highest stakes: outputs must be framed as drafts,
human sign-off via approvals / human agents; norms must come from the KB with citations, not model memory.

## 5. Risks and open decisions

- **Small local models** are weak at tool use (a minimal-profile run already stalled by refusing to call
  `report_task_status`); KB/tool-heavy flows raise this risk. Mitigate with guards, prompts and
  orchestration, not model upgrades (cost/local priority).
- **Classifier noise:** every `mcp__*` tool is gated by default; without a per-pack allowlist domain tools
  will prompt on every read.
- **Prompt budget:** KB must be retrieval, not prompt text.
- **Auth:** still none (user switcher is not authentication); more domains/users make this more visible.
- **Minimal profile:** everything must be SQLite-compatible (no `skipDuplicates`, `mode: insensitive`).
- **Safety framing** for construction-type domains (liability): disclaimers + mandatory human review.

Open decisions for the owner:
1. Which domain is the pilot (recommendation: language learning, then modeling, then construction).
2. Is `Project` entity worth the refactor now, or do we stay one-container-per-project until Phase 0 shows pain?
3. KB: FTS-only first (recommended) or embeddings from the start?
4. Pack distribution: local folders now; GitHub-hosted pack registry later?
