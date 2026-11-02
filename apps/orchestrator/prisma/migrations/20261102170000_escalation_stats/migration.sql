-- Escalation statistics: why a run was an escalation and from which provider/model.
ALTER TABLE "AgentSession" ADD COLUMN "escalationReason" TEXT;
ALTER TABLE "AgentSession" ADD COLUMN "escalatedFrom" TEXT;
