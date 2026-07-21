-- Per-session usage capture for per-provider stats (roadmap Phase 5).
-- Nullable/additive: existing rows stay NULL and render as "—"/0 in the stats view.
ALTER TABLE "AgentSession" ADD COLUMN "inputTokens" INTEGER;
ALTER TABLE "AgentSession" ADD COLUMN "outputTokens" INTEGER;
ALTER TABLE "AgentSession" ADD COLUMN "cacheReadTokens" INTEGER;
ALTER TABLE "AgentSession" ADD COLUMN "cacheCreationTokens" INTEGER;
ALTER TABLE "AgentSession" ADD COLUMN "numTurns" INTEGER;
ALTER TABLE "AgentSession" ADD COLUMN "costUsd" DOUBLE PRECISION;
ALTER TABLE "AgentSession" ADD COLUMN "apiMs" INTEGER;
