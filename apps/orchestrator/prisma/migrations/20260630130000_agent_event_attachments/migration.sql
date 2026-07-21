-- Per-message attachment filenames on prompt (user message) events.
ALTER TABLE "AgentEvent" ADD COLUMN "attachments" TEXT[] NOT NULL DEFAULT '{}';
