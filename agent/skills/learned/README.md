# agent/skills/learned/

This directory is where the fleet learns. It is intentionally empty at setup time.

## Rules

- Files here are **written by agents**, never by a human directly (though a human approves
  every write — see below).
- Files here are **never auto-loaded as authoritative** the way `agent/skills/core/*` is — an
  agent should treat content here as "things this fleet has observed on this project," not as
  fixed convention, unless it has been promoted to `core/` by a human/Architect decision.
- Every write to this directory goes through the approval gate, same as any other dangerous
  tool call. Before an approved write is applied, the runtime snapshots the current version of
  the file so it can be rolled back with one command if the change turns out to be wrong.
- There is a size budget per file (recommended: 16 KB) and in total for this directory
  (recommended: 64 KB) mirroring the budget for `core/` skills. When a file approaches the
  limit, consolidate rather than keep appending — an agent should propose a condensed rewrite,
  not let the file grow unbounded.
- Consolidation/pruning of this directory should happen as a **scheduled, human-reviewed job**,
  not as something an agent does to its own output inside the same turn it's being evaluated in.
  Self-consolidation in the same session creates an incentive to describe one's own work
  favorably rather than accurately.
- If something learned here turns out to be a durable, fleet-wide convention (not just a
  project-specific quirk), propose promoting it into `agent/skills/core/` explicitly — that
  promotion is a human/Architect decision, made as a normal reviewed change, not something an
  agent does by writing directly to `core/` (which it cannot do — there is no tool path to it).

## Suggested naming

`agent/skills/learned/<project-or-topic>.md`, e.g. `learned/checkout-service-quirks.md`,
`learned/deploy-gotchas.md`. Keep one topic per file so consolidation and rollback stay scoped.
