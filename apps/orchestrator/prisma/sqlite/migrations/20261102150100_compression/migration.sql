-- Configurable text compression / filtering and the per-run savings it reports.
ALTER TABLE "AppSettings" ADD COLUMN "compression" TEXT;
ALTER TABLE "AgentSession" ADD COLUMN "compressionBefore" INTEGER;
ALTER TABLE "AgentSession" ADD COLUMN "compressionAfter" INTEGER;
ALTER TABLE "AgentSession" ADD COLUMN "compressionSaved" TEXT;
