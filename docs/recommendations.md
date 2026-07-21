# Implementation Recommendations — AI Agency Orchestrator

> Companion to `implementation-local-server.md`. Written for handoff to implementation.
> Each section states the problem, the recommendation, and why it matters, ordered
> roughly by priority. Items reference the current v1 skeleton where relevant.

---

## 0. Priority summary

If only a few items can be tackled first, do these in order — each unblocks the next:

1. Minimal `User` model + identity binding on approvals (§2)
2. Replace in-process event bus with Redis Pub/Sub or Streams (§4)
3. Provider/model failover + task retries (§3)
4. Structured task-completion contract instead of free-text status (§1)
5. Everything else follows from these four.

---

## 1. Structured task-completion contract (reliability of subagent reporting)

**Problem:** Sub-agent completion is currently reconstructed from the SDK event stream and
free-text agent output. There is no guaranteed, structured signal that a task is actually
finished, blocked, or failed — the orchestrator has to infer it from `result`/`stderr` event
kinds. If a run ends without a clean `result` event (crash, silent stop, context truncation),
the task can be left in an ambiguous state with no automatic recovery.

**Recommendation:**
- Introduce a mandatory tool, e.g. `report_task_status(taskId, status, summary, files, handoff)`,
  as part of every agent's tool schema. The task's Postgres row is only allowed to transition to
  a terminal state (`done`, `failed`, `blocked`) when this tool is called — never from parsing
  prose.
- If an agent run ends (any reason: max turns, timeout, crash, disconnect) without this tool
  having been called, the **runtime** (not the agent) marks the task `stalled` and emits a
  `task:stalled` event. This must be a property of the orchestrator's run-completion handler,
  not a prompt instruction.
- Add a watchdog timer per task (configurable, default proportional to task complexity/agent).
  On expiry without a status report or heartbeat, the orchestrator automatically re-prompts the
  agent for its status once, then marks `stalled` if still no response — replacing manual
  "pinging."
- For long-running tasks, add an optional lightweight `heartbeat(taskId, progress)` tool call
  agents can use every N turns, distinct from the final status report, so the orchestrator can
  tell "still working" from "silently stuck."

**Why:** The current architecture already has the right instinct (event-sourced `AgentEvent`
rows are a good source of truth) — this closes the last gap where reporting still depends on the
model remembering to say the right thing at the right time.

---

## 2. Identity model for human roles (reviewer / task-setter)

**Problem:** There is no `User` table. Approvals carry a free-form `resolvedBy` string with no
binding to an actual identity. Before adding humans as first-class reviewer/task-setter roles
(and before any messenger channel integration), the system cannot distinguish "the operator
approved this" from "anyone who could reach the endpoint approved this."

**Recommendation:**
- Add a minimal `User` entity: `{id, displayName, role (operator | reviewer | task_setter |
  admin), channelIdentities[]}` where `channelIdentities` maps this user to their id on each
  connected channel (Telegram user id, Slack user id, etc.) — one person, many channels.
- Bind every `ApprovalRequest.resolvedBy` and every `Task.createdBy` to a `User.id`, not a
  string.
- Scope what each role can do at the API level, not just in the UI: `task_setter` can create
  tasks and comment; `reviewer` can approve/reject and request changes; `operator`/`admin` can
  additionally do merge/push/deploy confirmations and manage providers/agents/settings.
- This does not need to be a full auth system on day one (no SSO, no password flows required for
  a single-operator local deployment) — but the *data model* for identity and role must exist
  before humans are wired into the task graph, or every later feature (channel routing, approval
  gating, federation) will have to be retrofitted.

**Why:** This is a prerequisite, not a nice-to-have — channels, human review, and federation
(§6) all assume "we know who did this," and today the system doesn't.

---

## 3. Provider/model failover and task retry policy

**Problem:** `attempts: 1` at the BullMQ level (agent runs are correctly treated as non-
idempotent), and no fallback chain if a provider/model call fails at runtime. A misconfigured
provider, a transient API error, or a local model returning malformed tool calls (documented
gotcha: `qwen2.5-coder` returns `tool_calls` as plain text and breaks the SDK) simply fails the
task outright.

**Recommendation:**
- Define an explicit fallback chain per agent (already partially expressed via
  `model.fallbacks` pattern) and make the executor actually walk it on:
  - Provider unreachable / auth error
  - Malformed/non-structured tool-call response from a local model
  - Timeout below a "no progress" threshold
- Distinguish **retryable** failures (network blip, rate limit) from **non-retryable** ones
  (bad prompt, tool misuse) — only retry the former, and only up to a small bounded count, to
  respect the non-idempotent-run constraint.
- For local models specifically: validate structured tool-use support at provider registration
  time (a smoke test, similar to the existing provider `test` connectivity check), and refuse to
  route agent traffic to a model that fails the structured-output check, rather than discovering
  it mid-task.
- Surface failover events in the task transcript (`agent:log` kind `provider_failover`) so a
  human reviewing the task understands why the model changed mid-run.

**Why:** This directly protects the hybrid local/cloud economics story — a flaky local tier that
silently fails tasks defeats the purpose of routing cheap work there in the first place.

---

## 4. Replace in-process event bus with a durable, shared transport

**Problem:** `AgentEventBus` is a single-instance, in-memory `EventEmitter`. It cannot be
observed by a second orchestrator instance, has no replay/history for late subscribers, and does
not survive a process restart. This blocks horizontal scaling and, more importantly, blocks any
future multi-node/federation work (see §6).

**Recommendation:**
- Move event publication to Redis, which is already in the stack for BullMQ. Two reasonable
  options:
  - **Redis Pub/Sub** — minimal change, keeps the "live fire-and-forget" semantics, but still no
    replay for late joiners (acceptable if Postgres remains the durable source of truth for
    `AgentEvent` rows, which it already is).
  - **Redis Streams** — slightly more work, but gives consumer groups, replay-from-offset, and a
    natural path to a second orchestrator instance or a remote node consuming the same stream.
    Recommended if federation (§6) is on the near-term roadmap; Pub/Sub is fine if it is not.
- Keep Socket.IO as the browser-facing layer; it should subscribe to Redis, not replace it.
- This change is independent of and should land before federation work — it is required
  infrastructure, not itself the federation feature.

**Why:** No other federation work (shared task registry, remote heartbeat, cross-node task
handoff) is possible while the event bus is a single Node process's in-memory `EventEmitter`.

---

## 5. Learned-skill lifecycle: versioning, snapshot, rollback

**Problem:** Writing to `agent/skills/` is already approval-gated, which is good — but there is
no described mechanism for snapshotting before a change, rolling back a bad learned skill, or
distinguishing skills the fleet authored from skills a human/architect authored.

**Recommendation:**
- Directory-level separation: `agent/skills/core/` (human/architect-authored, never
  auto-modified) vs `agent/skills/learned/` (agent-authored, approval-gated writes only).
- Before any approved write to `learned/`, snapshot the current file (simple `.bak` or a
  content-addressed copy) so a bad approval can be reverted with one command, not by
  reconstructing from git history under time pressure.
- Add a periodic (not synchronous, not agent-triggered) consolidation pass — a scheduled job,
  not part of any agent's live turn — that reviews `learned/*`, merges/dedupes, and proposes the
  result as a normal approval-gated diff. Do not let an agent consolidate its own memory
  unsupervised in the same turn it is being evaluated in; the incentive to "look good" biases
  self-consolidation (this is a documented failure mode in comparable systems).
- Consider a size cap per learned-skill file (mirroring the existing 16 KB/file, 64 KB total
  budget for skills generally) that forces consolidation rather than unbounded growth.

**Why:** Approval-gating the write is necessary but not sufficient — without snapshot/rollback,
one bad approved change degrades the fleet's behavior with no fast recovery path, and without
scheduled (not self-triggered) consolidation, learned content will either bloat context or drift
toward self-congratulatory summaries.

---

## 6. Federation groundwork (multi-node: your machine + colleague's / remote server)

**Problem:** Today the system assumes one operator, one Postgres, one Redis, one set of
worktrees. Extending to a second machine (colleague's laptop, remote server) needs to be staged,
not attempted as one big change.

**Recommendation — staged rollout, in order:**

**Level 1 — Share compute only.**
Add the remote machine's local model (Ollama/LM Studio) as an additional LiteLLM provider,
reachable over Tailscale (already present in config, currently disabled — enable it). No task or
file data crosses machines, only model completions. This is low-risk and should be the first
experiment.

**Level 2 — Share execution backend, keep project local.**
Allow a task's shell/tool execution to run over SSH on a remote host while the task's state,
history, and skills remain on the originating orchestrator. Useful when a colleague's machine has
more compute for builds/tests than the requesting machine.

**Level 3 — Full task federation.**
Only attempt once §2 (identity), §3 (failover), and §4 (durable event bus) are done:
- A lightweight fleet registry (Redis-backed heartbeat: `{nodeId, capacityFree,
  modelsAvailable, projectScopes}`) so a router can ask "who can take this."
- Git-as-transport for task handoff where possible (clone branch → remote node works → pushes a
  feature branch → returns a PR link) rather than syncing full working directories.
- Look at Google's **A2A (Agent2Agent)** protocol as a reference for the task/artifact/status
  contract rather than inventing one from scratch — even partial adoption of its shape
  (task, artifact, status-push) will make future interop easier.

**Cross-cutting requirements before any task is allowed to leave the local node:**
- A `delegatable` flag on the task (or task type), defaulting to `false`. Explicit opt-in only.
- No credentials/secrets travel with a delegated task by default. Anything requiring a secret
  (deploy keys, DB creds) stays local; delegated work is scoped to what can run without them.
- Results from a remote node come back as a proposal (diff/PR), never as a direct merge — the
  same merge/push/deploy gate that applies to local agents applies, unmodified, to federated
  results.
- Sandboxing on the receiving node is the receiving operator's responsibility, but the sending
  node should assume a compromised/malicious remote and never send more than the scoped task.

**Why:** This turns "add a second machine" from a single risky leap into an incremental rollout
where each level is independently useful and the highest-risk work (credential scoping, trust
boundaries) is not attempted until the infrastructure underneath it (identity, durable events,
failover) already exists.

---

## 7. Token/cost economics — make it observable, not just capped

**Problem:** Skill size caps (16 KB/file, 64 KB total) and prompt-caching-friendly structure are
good design, but there is currently no visibility into what a task actually cost, which agent/
model combinations are expensive, or whether caching is actually hitting.

**Recommendation:**
- Persist token usage (input, output, cache-read, cache-write) per `AgentSession`, sourced from
  the SDK's usage reporting where available.
- Add a per-task and per-agent cost rollup, surfaced in the dashboard (`/tasks/[id]` already
  shows a transcript — add a cost line; `/agents` already shows model config — add a rolling
  cost/task-count stat).
- Track cache-hit rate specifically. If the system prompt (SOUL.md + skills) isn't reliably
  hitting the provider's prompt cache, that is worth knowing before assuming the caching
  architecture is delivering the expected savings.
- This data also directly informs §3 (failover) decisions and future federation load-balancing
  (§6) — "which node/model is both available and cheap" needs real numbers, not assumptions.

**Why:** The hybrid local/API pitch is fundamentally a cost argument. Without per-task cost data,
there's no way to validate that the architecture is actually delivering the economics it's
designed around.

---

## 8. Minor items worth tracking (lower priority, cheap to fix)

- **Two-Postgres-DB gotcha** (LiteLLM's destructive prisma sync): already documented — turn this
  into an automated pre-flight check on `docker compose up` that fails loudly if the DBs are
  misconfigured, rather than relying on the doc being read.
- **`EADDRINUSE :3001` on `nest --watch`**: add a `predev` cleanup step or health-checked
  container restart policy so this doesn't require manual `docker compose restart`.
- **Structured tool-use validation for local models**: covered in §3, but worth calling out as
  its own smoke test independent of the general failover work, since it's a known, reproducible
  break (`qwen2.5-coder`).

---

## Suggested sequencing for implementation tickets

```
1. User/identity model + approval binding                (§2)
2. Redis-based event bus (Pub/Sub or Streams)             (§4)
3. Provider failover + retry policy + local-model smoke test (§3)
4. report_task_status structured tool + watchdog          (§1)
5. Token/cost tracking per session                        (§7)
6. Learned-skill snapshot/rollback + scheduled consolidation (§5)
7. Federation Level 1 (shared compute via Tailscale)       (§6)
8. Federation Level 2/3 (execution backend, task handoff)  (§6, after 1-3 are stable)
```
