# Plan — modular runtime: deploy profiles (full ↔ minimal/single-container)

Goal: make the infrastructure pieces **pluggable modules** selected by config,
so the same codebase runs in two first-class profiles:

- **full** — today's compose stack (postgres, redis, litellm, dashboard as
  separate services): the local "полноценная инфраструктура", best for dev
  (hot-reload per service, real postgres).
- **minimal** — everything embedded in **one container** (SQLite file, in-process
  queue, litellm as a child process, dashboard co-located): one artifact you can
  `docker run` on an AWS instance or any VM.

Neither replaces the other; modules are chosen at boot. Aligns with the
cheap+local priority — and gives a cheap cloud story (a t4g.small runs the
minimal profile; models via Ollama on the same host or any provider litellm
reaches).

## Module matrix

| Module | Interface (exists today?) | `full` impl | `minimal` impl | Selection |
| --- | --- | --- | --- | --- |
| Storage | `PrismaService` token (✅ Phase 2) | postgres | SQLite file in `/data` (`prisma/sqlite/`) | `DATABASE_URL` scheme (`postgresql://` vs `file:`) |
| Queue | `TaskQueue` token (✅ Phase 1) | BullMQ + redis | in-process DB-backed poller (`QueueJob` table) | `REDIS_URL` set → BullMQ, unset → embedded |
| Event bus | `AgentEventBus` token (✅ Phase 2, scope discovery) | Redis pub/sub (cross-instance) | in-process `EventEmitter` | same signal as Queue (`REDIS_URL`) |
| LLM gateway | `LitellmService` (✅ Phase 3) | litellm container, admin API | litellm **child process**, static config (`ManagedLitellmRoute` table) | `LITELLM_MANAGED=1` |
| Dashboard | HTTP (✅ Phase 4) | separate Vite dev container (hot-reload) | Vite SPA build served same-origin by the orchestrator (`ServeStaticModule`) | build target |
| Browser tool (playwright-mcp) | MCP registry (yes) | optional compose profile | omitted (or remote MCP URL) | already optional |
| Ollama | provider record | host daemon | host daemon / any endpoint | already config |

Principle: **capability detection by env, no new "profile" flag** — the presence
and scheme of `DATABASE_URL`/`REDIS_URL`/`LITELLM_MANAGED` picks each module
independently. "Profiles" are just documented env presets (+ two compose files /
one Dockerfile), not code branches.

## Decisions (2026-07-21)

- Modules over migration: postgres/redis are NOT dropped — they stay as the
  `full` implementations. New embedded implementations are added beside them.
- **Storage duality and Prisma:** the datasource `provider` cannot be switched
  at runtime. One schema **template** → a build step emits
  `schema.postgres.prisma` + `schema.sqlite.prisma` and generates two clients;
  a `StorageModule` picks by `DATABASE_URL` scheme. Consequences for the shared
  template (lowest-common-denominator):
  - enums → `String` (SQLite has none) with validation at the boundary — the
    real contract already lives in `@lds/shared` union types;
  - `String[]` (e.g. `AgentEvent.attachments`) → JSON-encoded `String`;
  - two `migrations/` trees (postgres keeps its history; sqlite starts fresh).
- **Queue duality:** keep the current `TaskQueueService` surface (`enqueue`,
  `delayMs`) as the interface; BullMQ impl stays as-is; add an embedded
  DB-poller impl (claim column / `runAfter`, `agentConcurrency` slots).
  Startup orphan reconciliation already covers crash recovery for both.
- **litellm strategy — RESOLVED (b), by the Phase 0 spike (2026-07-21):**
  - (c) is dead: a DB-less litellm (`main-stable`) answers `/model/new` with
    500 `"No DB Connected"` — the admin API hard-requires the DB. Static
    config routes still serve fine.
  - (a) rejected as the default: an embedded postgres just for route storage
    is the heaviest possible answer to "persist a handful of yaml lines".
  - **(b) chosen:** the orchestrator renders `litellm-config.yaml` from its
    provider records and restarts the litellm child process on provider CRUD.
    Measured: cold boot → ready **16 s**, restart → ready **9 s** — fine for a
    rare admin action. Minimal-profile `LitellmService` becomes "regenerate +
    restart"; note routes are then read-only between restarts, so the lazy
    `ensureRoute` at agent-spawn must be a no-op (route presence is guaranteed
    by generation) rather than an admin-API call.
- **Remote exposure (AWS) is a real deployment, not localhost:** the dashboard's
  user-switcher is not authentication. Minimal-profile docs must front it with
  something (Tailscale/VPN, an authenticating reverse proxy, or at least
  binding + `MCP_TOKEN` as today). Full auth is out of scope here — flagged,
  not solved.

## What the minimal profile accepts

- Coarser restarts (one code deploy restarts all processes; s6 still restarts
  crashed services individually), interleaved logs (per-process prefixes).
- SQLite write concurrency (fine: `agentConcurrency=1` in shared mode, WAL on).
- No per-service scaling — irrelevant at this size.

## Phase 0 — Spike: litellm without its DB  ✅ DONE (2026-07-21)

Ran `ghcr.io/berriai/litellm:main-stable` with no `DATABASE_URL` (static config
only): boots fine (16 s to ready), serves static routes; `/model/new` → 500
`"No DB Connected"`; restart → ready in 9 s. **Decision: (b)** — see above.

## Phase 1 — Queue module ✅ DONE (2026-07-21)

`TaskQueue` abstract (queue.constants.ts) with two drivers: `BullTaskQueue`
(REDIS_URL set) and `EmbeddedTaskQueue` (unset) — a 1 s in-process poller over
the new `QueueJob` table (migration `20260721120000_queue_job`), atomic
updateMany claim, one-attempt semantics, stale claims dropped on worker start.
`RedisModule` provides null when embedded (no connection retry storm).
Verified: embedded driver behavioral suite (dedup / follow-up / remove /
stale-claim / delayed / FIFO) green against the real DB; full-profile e2e — a
noop task ran queued→done through the reworked BullMQ path in seconds.

## Phase 2 — Storage module ✅ DONE (2026-07-21)

- **Schema template**: `prisma/generate-sqlite-schema.mjs` transforms
  `schema.prisma` (unchanged, still the postgres/`full`-profile source of
  truth) into `prisma/sqlite/schema.prisma` — the 3 enums → `String` +
  `@default("member")`, the one scalar-list column (`AgentEvent.attachments`)
  → a JSON-encoded `String`, datasource/generator output repointed. Generated
  output is **committed** (not gitignored) so drift is visible in review, not
  silent build magic; re-run `pnpm --filter @lds/orchestrator prisma:sync`
  after editing `schema.prisma`. Its own migration history lives in
  `prisma/sqlite/migrations/` (separate from postgres's `prisma/migrations/`),
  driven by a sibling `prisma.sqlite.config.ts`. Client generated to
  `src/generated/prisma-sqlite` (gitignored, same as the postgres client) via
  the `@prisma/adapter-better-sqlite3` driver adapter.
- **`StorageModule` selection**: `AppConfigService.storageDriver` picks by
  `DATABASE_URL` scheme (`file:` → sqlite). `PrismaModule` binds BOTH
  `PrismaService` (postgres, untouched) and the new `PrismaServiceSqlite` to
  the **same DI token**, via a factory provider (same pattern as Phase 1's
  `TaskQueue`) — so all ~16 existing consumers keep injecting `PrismaService`
  and calling `this.prisma.task.findMany()` etc. unchanged. One explicit cast
  at the registration site covers the type gap (sqlite's generated types are
  wider — `status: string` vs postgres's enum literal union — but app code
  only ever writes the `@lds/shared` literals, so runtime values agree).
- **Scope discovery**: `AgentEventBus` (Redis pub/sub, used by ~7 consumers
  for WebSocket fan-out + the approvals long-poll) ALSO hard-required Redis,
  independent of the Phase 1 queue driver — a gap Phase 1 didn't cover since
  it only addressed the task queue. Added `LocalEventBus` (plain in-process
  `EventEmitter` — not a degraded mode: a single minimal-profile process has
  no "other instances" to fan out to, so Redis pub/sub was only ever needed
  for cross-instance delivery). `BusModule` picks it via the same signal as
  the queue driver (`queueDriver === 'bullmq'` ⇒ Redis, else local) — one
  env knob (`REDIS_URL`) now controls both the queue and the bus.
- **Verified**: sqlite client CRUD (status round-trips as a plain string,
  attachments JSON round-trips, native `Json` columns work) against a real
  file DB; a **full standalone NestJS boot** with `DATABASE_URL=file:...` and
  `REDIS_URL=` empty — zero Postgres, zero Redis processes — reached
  `{"status":"ok","db":true}`, and a real task flowed through
  create → embedded-queue claim → worker → failure (no model configured,
  the expected outcome in that throwaway env). Regression check: the live
  `full`-profile dev stack (postgres+redis) restarted clean afterward and
  correctly still picks `BullTaskQueue`/`AgentEventBus`(redis); a real task
  ran queued→done on it.

## Phase 3 — litellm module ✅ DONE (2026-07-21) — strategy (b)

- **Scope correction from the Phase 0 spike**: only litellm's WRITE admin API
  (`/model/new`/`/model/delete`) requires its own Postgres — a follow-up spike
  confirmed the READ side (`/model/info`, what the dashboard's routes view and
  the model picker use) works identically against a DB-less litellm. So
  `LitellmService`'s read methods (`listRoutes`/`listModelNames`) needed NO
  branch at all; only the 3 mutating methods (`registerRoute`/`ensureRoute`/
  `deleteRoutesFor`) delegate to a new `LitellmManagedService` when
  `config.litellmManaged` — a much smaller surface than a full parallel class.
- **`LitellmManagedService`** (`LITELLM_MANAGED=1`): persists routes in a new
  `ManagedLitellmRoute` table (the config-file equivalent of litellm's own
  Postgres), renders them + a static `litellm_settings`/`router_settings`
  block into a YAML file (hand-written serializer — always-double-quoted
  scalars, no library needed for a shape this fixed), and owns a litellm
  CHILD PROCESS via `child_process.spawn` (command/args from
  `LITELLM_MANAGED_COMMAND`/`_ARGS`, so the single image's actual binary path
  is just config). Restarts are serialized (a promise chain) so concurrent
  route CRUD can't race two restarts, and each restart polls `/v1/models`
  until ready (bounded) before returning — mirroring what a caller expects
  from the old synchronous admin-API call. `ensureRoute` on an already-
  present route is a true no-op (no restart) — verified below.
- No `local-coder`-style static alias is needed in managed mode — the FIRST
  provider sync (already run unconditionally on orchestrator boot) populates
  the table before any agent spawns.
- **Verified**: a real `litellm` binary (pip-installed locally, not Docker —
  closer to the single image's actual shape than a spike-only container)
  spawned/restarted directly from `LitellmManagedService`, driven through
  register → restart → model appears, ensure-on-existing → correctly no
  restart, register-2nd → both present, delete → only the other remains.
  Each restart completed in ~4-5s. Regression: the live `full`-profile dev
  stack rebuilt/restarted clean, `LitellmManagedService` stayed a no-op as
  designed, and the admin-API routes endpoint still lists all 7 existing
  routes unchanged.

## Phase 4 — Minimal image ✅ DONE (2026-07-21)

- **Simplified from the original s6-overlay plan**: litellm is already a
  Node-managed child process (`LitellmManagedService`, Phase 3) — the image
  only has TWO top-level processes (dashboard, orchestrator), not three, so a
  full init system is unwarranted complexity. `infra/minimal-supervisor.mjs`
  (plain Node, no deps) spawns both, restarts either on crash with a short
  backoff, and forwards SIGTERM/SIGINT — the same supervision pattern
  `LitellmManagedService` already applies one level down, just at the
  container's top level too.
- `infra/minimal.Dockerfile`: multi-stage (deps → build → runtime). Runtime
  is `node:22-bookworm-slim` + a `python3-venv` with `litellm[proxy]` pip-
  installed. Orchestrator dist + the full resolved `node_modules` tree ships
  as-is (not pruned to production-only yet — correctness over image size,
  logged as a Phase 4 follow-up, not a blocker). Dashboard ships via Next
  `output: 'standalone'` (added to `next.config.mjs`, plus a pinned
  `outputFileTracingRoot` — Next's tracing-root auto-detection walked up to a
  stray lockfile *outside* the repo on this dev machine and silently traced
  the wrong tree; pinning it fixed both that and cross-workspace-package
  tracing for `@lds/shared`).
- `infra/minimal-entrypoint.sh`: runs `prisma migrate deploy --config
  prisma.sqlite.config.ts` against `/data`, seeds the baked-in `agent/`
  defaults into `/data/agent` on first boot only (never overwrites — a later
  edit/removal of a default must not keep reverting), then execs the
  supervisor. `HealthController` (`/api/health`) now folds in a litellm
  reachability probe when `litellmManaged` — one healthcheck script covers
  both, simpler than the plan's original "probe /api/health + litellm /health".
- **Bugs found only by actually running the built image (not by review) —
  all fixed, all apply to BOTH profiles, not just minimal:**
  1. `.dockerignore` was missing `*.tsbuildinfo` (unlike `.gitignore`) — a
     stale host-side incremental-build cache file got baked into the image,
     and tsc's incremental logic silently emitted NOTHING for `@lds/shared`
     (exit 0, zero files) because it thought the (nonexistent, dockerignored)
     `dist/` was already up to date. Classic incremental-cache-in-the-wrong-
     place bug — costs a change to `.dockerignore`, not the build stage.
  2. pnpm doesn't hoist: `@lds/agent-runner`'s own dependencies (`zod`, the
     Claude Agent SDK) needed its `node_modules` copied into the runtime
     stage explicitly, not just its `dist`.
  3. `LitellmManagedService` spawned litellm with `...process.env` — litellm
     auto-detects ANY `DATABASE_URL` in its environment for its own (unused
     here) Postgres features and hard-errors on a non-postgres scheme,
     breaking boot entirely. Fixed: exclude `DATABASE_URL` from the child's
     inherited env.
  4. `PreflightService`'s Postgres-only sanity query (`pg_database`) ran
     unconditionally and warned/failed on sqlite — harmless (caught, logged)
     but noisy; skipped now when not on the postgres+admin-API combination.
  5. **`skipDuplicates: true` isn't supported on SQLite** (Prisma: "Unknown
     argument") — a REAL, previously-latent gap across 3 call sites
     (`ProvidersService.ensureSeeded`, `McpService.ensureSeeded`,
     `TasksService.linkReferences`). Fixed portably: query existing rows by
     their unique key first, `createMany` only the missing ones — works
     identically on both drivers, no branching needed.
  6. **`mode: 'insensitive'` isn't supported on SQLite either** (task search,
     `TasksService.list`) — fixed by branching on `storageDriver` (SQLite's
     own `contains`/LIKE is already ASCII case-insensitive by default, so
     omitting the flag there is the equivalent behavior, not a degraded one).
  7. `ProvidersService.onModuleInit`'s litellm resync ran BEFORE
     `ensureSeeded()` ever fires (that's lazy, on first `list()`/`get()`) — on
     a genuinely fresh DB/volume (only exercised by this Phase 4 test; the
     `full` profile's dev Postgres was never actually empty across the whole
     session) litellm stayed routeless until someone happened to hit
     `GET /providers`. Fixed: seed before resyncing.
  8. **The Phase 2 sqlite schema transform (enum→String, `AgentEvent.
     attachments` String[]→String) was never finished** — the schema/client
     layer was verified in Phase 2, but the 3 app-code read/write sites were
     never updated to encode/decode, so the FIRST real write (any agent
     event) crashed with a Prisma type-mismatch. Fixed with two centralized
     helpers (`encodeAttachments`/`decodeAttachments` in
     `prisma/agent-event-attachments.ts`) used at all 3 sites — the exact
     kind of gap that only surfaces by actually running a real task, not by
     re-reading the schema.
- **Verified end to end**: `docker build` → `docker run` with only `/data`
  mounted (no Postgres, no Redis, no separate litellm container) → healthy in
  ~6-11s → dashboard 200 → a REAL task (agentName=local-helper) flowed through
  create → embedded-queue claim → RealAgentExecutor → managed litellm →
  **the host's actual Ollama** → repeated real inference turns (multiple
  `200 OK`s on `/v1/messages`) → agent events persisted (attachments JSON-
  round-tripped, **zero** "Failed to persist event" across the whole run).
  The demo task itself settled `stalled` — the local model hallucinated a
  permission restriction and refused to call `report_task_status` — which is
  a model-quality issue orthogonal to this phase, and exactly the scenario
  the question-escalation feature (built earlier) is designed to catch: the
  salvaged last-message reason is ready for that mechanism to surface, not a
  packaging defect. Regression: the live `full` profile (postgres+redis+
  admin-API litellm) rebuilt/restarted clean after every fix in this list,
  since all of them are shared code paths.
- **Deliberately deferred, not done in this pass** (fine — none block the
  "does it actually work" story above): pruning the runtime `node_modules` to
  production-only (image is currently large, ~3GB); a `docker run` one-liner
  + AWS quick-start doc (README already has a placeholder "Server deployment
  (in progress)" section — fill it in once the image is pushed somewhere
  pullable, not a local `:test` tag); `LITELLM_MASTER_KEY`'s baked-in dev
  default flagged by Docker's own linter as `SecretsUsedInArgOrEnv` — real
  deployments should override it via `docker run -e`.

## Phase 5 — Docs & cleanup ✅ DONE (2026-07-21)

- README's "Server deployment" section rewritten from "in progress" to a
  working `docker build`/`docker run` recipe (image isn't published anywhere
  yet, so "build it from source" is the honest instruction), plus the env
  vars worth overriding for a real deployment and the backup story ("copy
  `/data`", nothing else to snapshot).
- `docs/implementation-local-server.md` gained a new §13 summarizing all four
  dual-implementation modules (storage/queue/bus/litellm) as one table, with
  the factory-provider pattern that keeps every consumer unchanged.
- Fixed a stale, actively-misleading default while touching this doc set
  (unrelated to deploy profiles, but found during this cleanup pass):
  `.env.example`/README's onboarding steps still told a new user to pull
  `qwen2.5-coder:32b` — the exact model documented elsewhere in this same repo
  as NOT emitting structured tool calls (breaks the agent SDK). Now
  `qwen3-coder:30b`, matching the actual code default and `.env`.
- No config keys deleted — both profiles are permanent, `full` stays default.

## Addendum — bare-metal (no Docker) install (2026-07-22)

Docker was mandatory for every server-deploy path (`install.sh` hard-`die`s without it).
The runtime the minimal profile actually needs — `infra/minimal-entrypoint.sh` (sqlite
migrate + seed agent defs) and `infra/minimal-supervisor.mjs` (fork/restart
dashboard+orchestrator) — never depended on containers; Docker was packaging/isolation,
not a capability. Parameterized both scripts' hardcoded `/app`/`/data` paths behind
`APP_DIR`/`DATA_DIR` (default unchanged, so the Docker image's behavior is byte-identical)
and added a bare-metal install path that builds from source and runs the same two scripts
directly as a systemd service instead of inside a container. `infra/update-check.sh` gained
a fallback to read the installed version from the `$INSTALL_DIR/current` symlink when no
Docker container exists, instead of only `docker inspect`.

**Follow-up (same day):** initially shipped as a separate `install-bare.sh` script,
duplicating `install.sh`'s fetch/version-resolution logic on purpose (both had to stay
self-contained for `curl | sh`). Live use surfaced real friction from having two entrypoints
— the operator has to know which to run, and picked wrong once. Merged into one `install.sh`
that detects Docker and, when found on a real (non-piped) terminal, **asks** whether to
install via Docker or bare-metal — Docker present doesn't imply it's meant for Aigentron
itself; it may be reserved for the project(s) the agents build/test in, with Aigentron
running bare-metal alongside it as the supervisor. `install-bare.sh` now survives only as a
3-line redirect (`INSTALL_MODE=bare` forced) — no duplicated logic, so no drift risk. See
the README's "Server deployment" §Option A.

Ollama needed no code change to become "optional" for this — it already was
(`ollama-local` is a soft, lazily-used seeded provider row; nothing preflight-checks it).
Just documented explicitly, since nothing said so before.

## Addendum — dashboard rewritten as a Vite SPA, served same-origin (2026-07-22)

Phase 4 shipped the dashboard as Next.js `output: 'standalone'`, relocated by hand into
`apps/dashboard-standalone/` (both in `infra/minimal.Dockerfile` and `install.sh`, kept in
sync manually) and run as a SECOND Node process by `infra/minimal-supervisor.mjs` — two
top-level processes, two exposed ports (`3000` dashboard, `3001` API), and the client bundle
had the orchestrator's URL baked in at build time (`NEXT_PUBLIC_ORCHESTRATOR_URL`), so
changing the orchestrator's port meant rebuilding the image.

`apps/dashboard` is now a Vite + React SPA (`react-router-dom`, CSS Modules, no Next
dependency at all). The orchestrator serves its `dist/` directly, in-process
(`ServeStaticModule.forRoot` in `app.module.ts`, `exclude: ['/api/*splat']`, with an
`index.html` SPA-fallback for client routes like `/tasks/:id` surviving a refresh) — same
origin, same port, zero build-time URL baking (the SPA defaults to relative `/api` paths;
`VITE_ORCHESTRATOR_URL`/`VITE_ORCHESTRATOR_WS_URL` are a dev-only escape hatch for the `full`
profile's separate hot-reload Vite server).

This retires both Phase 4 mechanisms that motivated the "two top-level processes" framing
above: the `dashboard-standalone` relocation dance is gone (Vite's flat `dist/` needs no
relocation), and `infra/minimal-supervisor.mjs` is deleted — `minimal`/`bare-metal` are down
to ONE Node process, so `infra/minimal-entrypoint.sh` execs the orchestrator directly and
relies on the container/systemd restart policy for crash recovery (the supervisor's own
per-child restart logic no longer has more than one child to matter for). `EXPOSE`/published
ports collapse to `3001` only; `DASHBOARD_PORT` and both `NEXT_PUBLIC_*` vars stop existing
in these two profiles. The `full` profile is unaffected beyond Next→Vite under its existing
separate dev-server service — hot-reload DX there is unchanged.

## Order & effort

0 ✅ → 1 ✅ → 2 ✅ → 3 ✅ → 4 ✅ → 5 ✅. All phases landed independently;
`full` stayed the default and the regression baseline throughout — verified
by rebuilding/restarting it after every phase change. The `minimal` profile
builds, runs, and has completed one real agent task end to end against the
host's real Ollama; it isn't published anywhere yet (build from source).
