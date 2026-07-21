-- Structured completion contract: new terminal statuses + agent-reported outcome
-- and heartbeat tracking on the session.

-- AlterEnum (add values; not used within this migration, so safe outside a txn value-use)
ALTER TYPE "TaskStatus" ADD VALUE IF NOT EXISTS 'blocked';
ALTER TYPE "TaskStatus" ADD VALUE IF NOT EXISTS 'stalled';

-- AlterTable
ALTER TABLE "AgentSession" ADD COLUMN "reportedStatus" TEXT;
ALTER TABLE "AgentSession" ADD COLUMN "reportedSummary" TEXT;
ALTER TABLE "AgentSession" ADD COLUMN "lastHeartbeatAt" TIMESTAMP(3);
