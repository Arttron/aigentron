# Documentation index

One line per file. Plans (`plan-*`) describe intent and may lag the code; the code is the source of truth.

## Start here
- [roadmap.md](roadmap.md) — phased implementation plan
- [BACKLOG.md](BACKLOG.md) — deferred ideas
- [ISSUES.md](ISSUES.md) — log of defects, fixes and process lessons
- [operating-model.md](operating-model.md) — how the service is used (analysis and design)
- [implementation-local-server.md](implementation-local-server.md) — implementation reference
- [recommendations.md](recommendations.md) — implementation recommendations
- [request-flow.md](request-flow.md) ([html](request-flow.html)) — how requests to agents and providers are built, what enters the context

## Running and operating
- [updates.md](updates.md) — updating the server
- [moving-servers.md](moving-servers.md) — moving to another server
- [small-servers.md](small-servers.md) — 2 vCPU servers
- [workspace-layout.md](workspace-layout.md) — workspace layout, env files, housekeeping
- [remote-access.md](remote-access.md) — dashboard through Cloudflare Tunnel + Access
- [authentication.md](authentication.md) — password sign-in
- [provider-login.md](provider-login.md) — Codex / Claude sign-in from the dashboard
- [languages.md](languages.md) — languages and tokens
- [plan-single-container.md](plan-single-container.md) — deploy profiles (full / minimal)

## Projects and code
- [projects.md](projects.md) — repositories and access
- [work-on-server.md](work-on-server.md) — working on a project's code directly on the server
- [finished-work-cleanup.md](finished-work-cleanup.md) — clearing checkouts of finished work
- [plan-projects-workspace.md](plan-projects-workspace.md) — projects and workspace design
- [plan-project-isolation.md](plan-project-isolation.md) — isolating clients' projects

## Agents and tasks
- [command-pipeline.md](command-pipeline.md) — command pipeline
- [discussions.md](discussions.md) — round-table between agents
- [questions.md](questions.md) — `ask_user`
- [subtask-after.md](subtask-after.md) — ordering subtasks with `after`
- [schedule-scripts.md](schedule-scripts.md) — scheduled scripts
- [message-box.md](message-box.md) — message box formatting
- [chat-search.md](chat-search.md) — search in chats
- [mcp-entry-point.md](mcp-entry-point.md) — drive the fleet from an external MCP client
- [rfc-001-channels-and-human-agents.md](rfc-001-channels-and-human-agents.md) — external channels, humans as agents
- [plan-agent-store.md](plan-agent-store.md) — agent store
- [plan-codex-runtime.md](plan-codex-runtime.md) — Codex as a runtime
- [plan-token-saving.md](plan-token-saving.md) — saving tokens and subscription limits
- [plan-provider-usage-stats.md](plan-provider-usage-stats.md) — per-provider usage stats

## Knowledge, packs, add-ons
- [knowledge-base.md](knowledge-base.md), [plan-knowledge-base.md](plan-knowledge-base.md) — knowledge bases
- [packs.md](packs.md), [plan-domain-packs.md](plan-domain-packs.md) — starter and domain packs
- [resources.md](resources.md) — libraries
- [addons.md](addons.md) — add-ons
- [browser-proxy.md](browser-proxy.md) — browser through a proxy
- [plan-browser-extension.md](plan-browser-extension.md) — browser extension
- [media.md](media.md) — camera, photos, video
- [voice.md](voice.md) — voice in and out

## Local agent (`aigentron`)
- [plan-local-agent.md](plan-local-agent.md) — the Go daemon on the person's machine (may lag the code)
- Protocol examples: `packages/shared/protocol/local-agent/README.md`

## Reviews and analysis
- [review/00-plan.md](review/00-plan.md) — code review plan; reports `01`–`05` in the same folder
- [ai-workflows-review.md](ai-workflows-review.md) — review of three AI-workflow articles: what we use, gaps, plan
- [website-dev-server-page-fixes.md](website-dev-server-page-fixes.md) — recommendations for the product web page

## Examples
- [examples/](examples/) — sample files
