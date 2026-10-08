# Plan: agent store (catalog of agents + skills, editable by hand or by an admin agent)

> Status: DRAFT (2026-10-07). Distribution layer for the domain packs in docs/plan-domain-packs.md.
> Today agents are files (`agent/agents/*.md`) and skills are files (`agent/skills/{core,learned}/*.md`);
> shipped ones are three-way-merged on update by `AgentFilesSyncService`, which deliberately skips
> `agents/*.md` (user-owned). The store makes agents installable, updatable and customizable units.

## 0. Decisions (2026-10-07, owner)

- Agents stay **stored locally as files**, exactly as today (`agent/agents/*.md`). No remote registry yet.
- On a **fresh install the agent list contains only the built-in `admin` agent.** It is chat-capable and runs
  on the **default provider configured after install** (setup wizard / Settings).
- The other shipped agents (pm, architect, backend, frontend, designer, coder, reviewer, local-helper) are
  **agent templates**, not installed agents: a bundled catalog the admin can instantiate and tailor on request.
  An instantiated template is an ordinary local agent; there is no live link to the template afterwards
  unless we add update tracking later (so "S1 merge-based updates" below is optional/deferred).
- Existing installs keep the agents they already have; only fresh installs get the reduced list.

## 0.1 Implemented so far (uncommitted, 2026-10-07)

- Templates moved to `agent/catalog/agents/`; built-in admin shipped as `agent/builtin/admin.md`.
- `AdminAgentSeedService`: seeds `agents/admin.md` once (marker `.sync/admin-seeded`); existing installs keep
  their agents and `defaultAgent`; `AgentFilesSyncService` keeps an existing admin current via 3-way merge.
- Fresh `AppSettings` default agent = `admin`; `admin` can't be deleted or have prompt/tools changed via the
  Agents API (routing — provider/model/fallbacks — may be edited); not offered as a subagent.
- Admin tools (in-process, admin only): `catalog_list`, `catalog_get`, `agents_list` (read) and
  `propose_agent`, `propose_skill` (approval-gated; the approval card shows the full content).
  Names differ from the sketch in §4 (`catalog_search`/`propose_agent_edit`/`install_package`): a single
  `propose_agent` covers create and edit, and "install" is just proposing a tailored template.
- Agent identity = file name; a `name:` line in frontmatter is ignored/rejected (can't impersonate a built-in).
- Custom skills go to `agent/skills/core/custom/`; names can't shadow existing skills.
- Platform management (all mutations through approvals): `tasks_list` (read), `propose_task_action`
  (cancel/delete explicit task ids, never the admin's own chat task), `propose_agent_delete` (snapshot first).
  The approval card lists what will be touched. Admin prompt carries explicit limits/honesty rules and the
  Claude Code built-in to-do/task tools are disabled for it (they were mistaken for platform tasks).
- NOT yet (superseded: chat mode and widget are done): chat mode (task without worktree/verify/publish), Chat page, first-run provider guard.

## 1. Concepts

- **Store package** = one agent + the skills it needs + declared requirements. The unit of install.
- **Pack** = a named bundle of packages (e.g. `dev`, `language-learning`). Packs are just a list, no extra format.
- **Catalog** = index of packages from one or more sources: bundled (ships in the release), a local
  folder, later a remote registry (a GitHub repo with `index.json`).
- **Installed agent** = normal `agent/agents/<name>.md` + its skills, plus a DB record that remembers
  where it came from, so it can be updated or reset.

## 2. Package format

```
catalog/<id>/
  package.yaml        # id, version, title, description, tags/domain, author, license,
                      # skills: [..], requires: { mcp: [..], binaries: [..], capabilities: [vision, tool-use] }
  agent.md            # exactly today's agent file (frontmatter + system prompt body)
  skills/<name>.md    # skills bundled with this agent (namespaced <id>/<name> on install)
  README.md           # shown in the store card
```
A bare single-file agent (current format) stays valid: it simply has no manifest and is treated as
"local, not from the store". Skills shared by several packages are deduped by `<id>/<name>` + hash.

## 3. Install / update / customize lifecycle

`InstalledPackage { id, version, source, baseHash (of the shipped files), installedAt }`.
- **Install:** copy `agent.md` -> `agent/agents/<name>.md`, skills -> `agent/skills/core/<id>/`, register
  declared MCP definitions (disabled until the user approves them), run the requirements check.
- **Local edits:** compare current files with `baseHash`. Edited => card shows "modified".
- **Update:** reuse the three-way merge from `AgentFilesSyncService` (base = shipped version at install,
  theirs = new version, ours = local file). Untouched -> straight update; edited -> merge, conflict -> show
  diff and let the user keep / take new / merge by hand.
- **Reset to store version / Uninstall:** snapshot first (same `.snapshots` mechanism as learned skills).
- **Fork:** "Save as new agent" detaches it from the store (no more updates).

## 4. Editing: manually or by the admin agent

**Manual:** the existing Agents page (CRUD over `agent/agents/*.md`) plus a skills editor (new).

**Admin agent (`agent-admin`, built-in):** a read-mostly agent that helps create and tailor agents:
"make me a tutor for German A2 that uses my textbook", "give the reviewer a stricter checklist".
- Agents cannot write `agent/agents/`, `skills/core/` or SOUL.md (protected paths in the classifier),
  and that stays true. The admin agent uses dedicated in-process tools instead, modeled on
  `propose_learned_skill`:
  - `catalog_search(query)`, `catalog_get(id)` — browse the store;
  - `install_package(id)` — goes through approval;
  - `propose_agent(name, content)` / `propose_agent_edit(name, newContent)` — create or change an agent file;
  - `propose_skill(name, content)` — create or change a skill.
- Every proposal is an **approval with a diff** (before/after), snapshot on apply, budget limits as for
  learned skills (16 KB / file). Nothing is written without a human click.
- The admin agent never touches SOUL.md or provider secrets, and cannot grant itself tools or MCP servers
  beyond what the approver sees in the diff (the diff must show `allowedTools` / `mcp` changes prominently).
- Which model it runs on is a normal provider setting (any provider, local or cloud).

## 5. Dashboard

- **Store page:** grid of cards (title, description, domain tags, skills count, requirement status),
  filters, search; detail view with the system prompt and skills (read-only preview), Install/Update/Remove.
- Requirement badges: "needs MCP `freecad` — not configured", "needs binary `blender` — not found",
  "needs vision-capable provider".
- **Agents page:** source badge (store `id@version` / local), "modified", Update available, Reset, Fork.
- **Admin chat:** an "Ask the admin agent" entry on the Store and Agents pages that opens a task
  assigned to `agent-admin`, with pending proposals shown as diffs in the approvals queue.

## 6. Security

A package is executable policy: its prompt, `allowedTools` and `mcp` config decide what an agent may do.
- Bundled and local sources: trusted at the user's own risk level.
- Remote registry (later): signed index, pinned versions, review required; MCP configs and tool grants in
  a package are shown at install and need explicit approval; never auto-update.
- Installed MCP definitions start disabled; the classifier keeps gating `mcp__*` tools until a per-package
  read-only allowlist (from the manifest) is approved.

## 7. Phases

- **S0 — format + bundled catalog.** Define `package.yaml`; convert the 8 shipped agents + their skills into
  the `dev` pack; `catalog` service lists them; no behavior change for existing installs.
- **S1 — install/update/reset API + Store UI.** `InstalledPackage` table (Postgres + SQLite migrations),
  merge-based update, snapshots, source/modified badges on the Agents page.
- **S2 — admin agent.** `agent-admin` + `propose_agent*`/`propose_skill`/`install_package` tools, approval
  with diff view, skills editor in the dashboard.
- **S3 — requirements check.** Verify MCP/binaries/provider capabilities at install and before a run
  (fails early instead of at run time).
- **S4 — remote registry.** GitHub-hosted index, signing, version pinning.
- **S5 — first domain packs** (language learning first), per docs/plan-domain-packs.md.

## 8. Open decisions

1. Granularity: package = agent (+skills) with packs as lists (proposed) vs. only packs.
2. Skill namespacing `<id>/<name>` (safe, proposed) vs. keeping bare names (current, collision-prone).
3. Admin agent autonomy: every proposal needs approval (proposed) vs. auto-apply for drafts of *new* agents.
4. Remote registry in the first iteration, or bundled + local folder only (proposed).
