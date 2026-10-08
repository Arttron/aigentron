# arttron.dev/en/dev-server — recommendations

> Reviewed 2026-07-21 against the current repo state (v0.1.0, first public release).
> This page lives in a separate site repo, not this one — this is a handoff document,
> not something I can fix directly. Content pulled from the page's own Next.js i18n
> JSON payload (SSR), quoted verbatim.

## What the page actually is (found while digging into the payload)

Beyond the two tabs, the page has a **version dropdown + Download button** I missed on
first pass:
```
"title":"Local Dev Server",
"subtitle":"A self-hosted orchestration platform that runs a fleet of Claude Code agents for autonomous development",
"downloadDesc":"Complete project source code — ready to run locally or deploy",
"downloadBtn":"Download",
"versionLabel":"Version",
"versionLatest":"Latest",
"preparing":"Preparing archive...",
"downloadNote":"The archive is generated on-the-fly with source files. Extract and follow one of the setup guides below."
```
The rendered `<select class="versionSelect">` is currently **empty** (no `<option>` in
the static HTML — may populate client-side, can't confirm from a static fetch). This is
a third distribution channel alongside GitHub Releases and the internal S3 prefix: the
site apparently generates a source archive on demand via `/api/download/dev-server`
rather than serving a GitHub tag archive directly.

**Recommendation:** don't maintain a fourth archive-generation implementation. Point this
feature at the release pipeline that already exists:
- Populate the version dropdown from `GET https://api.github.com/repos/Arttron/aigentron/releases`
  (or `/releases/latest` for just the "Latest" entry) — this is the same API `install.sh`
  and `infra/update-check.sh` already use, so there's one source of truth for "what
  versions exist."
- Have `/api/download/dev-server?version=vX.Y.Z` redirect to (or proxy)
  `https://github.com/Arttron/aigentron/archive/refs/tags/vX.Y.Z.tar.gz` instead of
  generating anything on the fly — GitHub already does this for free, and it's exactly
  what a visitor gets from `install.sh` anyway, so the web download and the CLI install
  produce identical archives.
- `archiveSize: "Archive size: {size}"` then becomes trivial: it's just the `Content-
  Length` GitHub returns, not something to compute.

## Project description (ready-to-use copy)

Current `title`/`subtitle` are accurate, just need the rebrand:

```
title: "Aigentron"
subtitle: "A self-hosted orchestration platform that runs a fleet of Claude Code agents for autonomous development"
```

Slightly expanded version, if there's room for more than a one-line subtitle:

> Aigentron runs a fleet of Claude Code agents against your codebase autonomously — an
> orchestrator (task lifecycle, model routing, human approval gates for dangerous
> actions) plus a dashboard for watching and steering runs. Two ways to run it: a full
> multi-service stack for local development, or a single-container profile for a real
> server. MIT licensed.

## Installation & setup process (ready-to-use copy)

### Tab "Local Installation" — for developing/trying it out locally

```bash
git clone https://github.com/Arttron/aigentron.git
cd aigentron
cp .env.example .env
# fill in ANTHROPIC_API_KEY and, if needed, your tool-capable local model name

ollama pull qwen3-coder:30b        # NOT qwen2.5-coder — see note below

docker network create lds-agents   # one-time

docker compose up --build -d
```
- Dashboard → `http://localhost:3000` · Orchestrator API → `http://localhost:3001`
- **Model note:** `qwen3-coder:30b` supports structured tool calls; `qwen2.5-coder` and
  DeepSeek-family models do not and will break the agent SDK. This isn't an
  OpenAI-vs-not distinction — it's specific tool-calling support per model.
- This brings up Postgres, Redis, LiteLLM, the orchestrator, and the dashboard,
  bind-mounted for hot-reload — the full/dev profile, meant for working on the project
  itself, not for a production deployment.

### Tab "Server Deployment" — for running it on a real server

```bash
curl -fsSL https://raw.githubusercontent.com/Arttron/aigentron/main/install.sh | sh

# pin an explicit version instead of resolving latest — do this for anything
# beyond a quick test:
VERSION=0.1.0 sh install.sh
```
- No container registry, no pre-built image to pull — this downloads a source archive
  for the chosen version and builds `infra/minimal.Dockerfile` locally.
- Single container: orchestrator + dashboard + LiteLLM (spawned as a child process) in
  one Node process, SQLite instead of Postgres, an in-process queue instead of Redis —
  no external services to run.
- Status: **published** — `v0.1.0` is a real GitHub Release with a downloadable tag
  archive; verified end to end including a real agent task against a local Ollama.
- See all versions: `https://github.com/Arttron/aigentron/releases`

## Detailed audit — what's currently wrong, tab by tab

### Tab 1 — "Local: git clone + Docker Compose"

| # | Current text on the site | Problem | Fix |
|---|---|---|---|
| 1 | `prereqModel`: "default qwen2.5-coder:32b"; `step2Cmd`: `ollama pull qwen2.5-coder:32b` | This is the exact model the project's own docs say to **avoid** — it doesn't emit structured tool calls and breaks the agent SDK. Following this produces a guaranteed-broken install. | `qwen3-coder:30b` (matches `.env.example`'s `ROUTINE_MODEL`) |
| 2 | `prereqModelNote`: "non-OpenAI models like DeepSeek don't emit structured tool calls" | Self-contradictory — the recommended qwen2.5-coder is *also* non-OpenAI. The real axis is specific tool-calling support, not OpenAI-vs-not. | See model note above |
| 3 | `step3Cmd`: `docker network create dev-sandbox`; `step4Desc` references a `dev-sandbox_data` volume | Doesn't match the repo — README and `docker-compose.yml` both use `lds-agents`; no `dev-sandbox_data` volume exists anywhere. | `docker network create lds-agents`; drop the fabricated volume name |
| 4 | Clone command: `github.com/your-org/local-dev-server.git` | Placeholder — the real public repo exists now. | `https://github.com/Arttron/aigentron.git` |
| 5 | `<title>`, `og:title`, `twitter:title`, meta description — "Local Dev Server" (all 7 hreflang variants: en/ru/et/lv/lt/de/es) | Product is now branded Aigentron (public-facing name only, per the earlier renaming decision). | "Aigentron" |

### Tab 2 — "Server Deployment"

Describes a flow that was **never actually built**:

**Current (`serverCurlCmd`):**
```
curl -LO https://your-server.com/api/download/dev-server
tar xzf local-dev-server.zip
cd local-dev-server
./bin/setup.sh
```
No `.zip` archive or `bin/setup.sh` exist in the project — see the corrected copy above.

**`serverStatus`** currently reads:
> "🚧 Not yet published as a pullable image or install script — build from source for now."

Now false — `v0.1.0` is published and `install.sh` works end to end. Replace per the
"ready-to-use copy" section above.

`serverProfile1`–`serverProfile4` (single-process, SQLite, in-process queue, no
Postgres/Redis) are accurate as-is — no change needed.

## Versioning — how the page should work with versions going forward

Two related things need version awareness: the copy on the page, and the
version-dropdown/Download feature described above.

**Don't hardcode a version number in page copy.** The `qwen2.5-coder` mistake above is
exactly what happens when documentation text isn't tied to a source of truth — nobody's
job to remember updating it on every release. Either:
- show a "Latest: vX.Y.Z" line fetched from `GET .../releases/latest` (SSR or
  client-side), or
- skip the number and just link "See all releases →" to the GitHub Releases page.

**The version dropdown should be populated the same way**, from `GET .../releases` —
one source of truth (GitHub Releases) feeding both the CLI (`install.sh`,
`update-check.sh`) and the website, instead of the site maintaining its own separate
notion of "what versions exist."
