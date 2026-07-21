# Plan — per-provider usage statistics (tokens / requests)

Implements roadmap **Phase 5 (cost/usage observability)**. Goal: see, per provider,
how many tokens and API requests the fleet has spent over a time range.

## Decisions (2026-07-13)

- **Primary metrics:** tokens (input / output / cache) + request count (Σ `num_turns`).
- **Cost:** captured (free — already in the stream) but secondary/`est.` in the UI, since the
  SDK figure is accurate only for Anthropic and approximate/0 for others via LiteLLM.
- **Grouping:** by provider only (no per-model breakdown).
- **UI:** a standalone `/stats` page (date-range picker + provider table).
- Aligns with the project's cheap+local priority: **zero extra API calls** — we persist usage
  that already arrives in the SDK result stream; storage is a few ints per session.

## Data source

The SDK result message (`SDKResultSuccess`) already carries everything. NOTE:
`usage` is the SDK's `NonNullableUsage` (= Anthropic `BetaUsage`), so its subfields
are **snake_case** (an earlier draft here wrongly listed them camelCase):

```
usage: { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens }
modelUsage: Record<model, { inputTokens, outputTokens, cacheRead…, costUSD, … }>  // camelCase (different type)
total_cost_usd: number
num_turns: number
duration_api_ms: number
```

`AgentSession` already stores `provider` + `model`, so aggregating by provider is
"persist usage on the session → GROUP BY provider". Each failover run is its own
`AgentSession`, so usage is attributed to the provider that actually ran.

Not currently captured: `agent-runner` only reads `total_cost_usd` and `num_turns` for the
`result` event and persists neither. Phase 1 fixes that.

## Phase 1 — Capture per session ✅ DONE

- `packages/agent-runner`: added `RunUsage` + `usage` on `AgentRunResult`, populated from the
  result message (snake_case reads, null→0); `emptyUsage`/`addUsage` helpers in `usage.ts`.
- Migration `20260713120000_agent_session_usage`: nullable columns `inputTokens`, `outputTokens`,
  `cacheReadTokens`, `cacheCreationTokens`, `numTurns`, `costUsd` (DOUBLE PRECISION), `apiMs`.
- `real-agent-executor`: writes them in the end-of-run `agentSession.update`.
- **Accumulation:** the run now also does a "reporting-resume" (a 2nd SDK call on the same
  session when the agent skipped report_task_status). Its usage is summed into the session via
  `addUsage(result.usage, resumeUsage)` — otherwise the reporting turn's tokens/cost go uncounted.
- Migration is committed but must still be applied to each DB (`prisma migrate deploy`).
- Risk: low (additive fields only).

## Phase 2 — Aggregate + API ✅ DONE

- `StatsService.usageByProvider({ from?, to? })` — Prisma `groupBy` on `AgentSession` by
  `provider` (`_count._all` + `_sum` of tokens/`numTurns`/`costUsd`), filtered on `startedAt`;
  null sums → 0; rows sorted busiest-first (Σ requests) with a name tiebreak.
- `GET /api/stats/usage?from&to` (`StatsController`, `@Roles('operator','admin')`), query
  validated by `UsageQueryDto` (`@IsDateString` from/to). Returns `UsageReport { from, to, totals,
  providers[] }` with `ProviderUsage { provider, sessions, requests, inputTokens, outputTokens,
  cacheTokens, estCostUsd }`.
- Wire types `ProviderUsage` / `UsageReport` live in `@lds/shared` (Phase 3 dashboard reuses them).
- `StatsModule` registered in `app.module`; no extra imports (Prisma + Users are global).
- Risk: low.

## Phase 3 — Dashboard `/stats` ✅ DONE

- `apps/dashboard/src/app/stats/page.tsx` (+ `page.module.css`): client page with a range picker
  (Today / 7d / 30d / All time, computed client-side into `from`) and a sortable provider table
  (click any header; default requests-desc) with a totals row. `est. cost` is a muted secondary
  column (0 → "—" since LiteLLM reports none).
- `api.getUsage({from,to})` in `lib/api.ts` sends `x-lds-user` (guarded route); wire types reused
  from `@lds/shared`.
- Nav link added on the home header (`📊 Stats`). No shared table component existed, so the table
  is a small local CSS module (matches the project's CSS-module convention).
- Risk: medium (new page). Typecheck + lint clean; runtime needs the stack up.

## Phase 4 — (optional) LiteLLM authoritative cost

- For LiteLLM-routed providers, optionally pull `/global/spend/report` for authoritative cost as
  a secondary column. Only if the SDK estimate proves insufficient.

## Retention

No rollup table initially — sessions are already persisted; aggregate on the fly. Add a daily
rollup later only if history grows large enough to matter.

## Notes

- Stats populate **from the Phase 1 deploy onward**; pre-existing sessions have empty usage
  columns and will show as 0 / "—". Expected.
- Delivery: phases 1 → 2 → 3, one commit each.
