-- ask_user: several options can be chosen.
ALTER TABLE "AgentQuestion" ADD COLUMN "multiple" BOOLEAN NOT NULL DEFAULT false;
