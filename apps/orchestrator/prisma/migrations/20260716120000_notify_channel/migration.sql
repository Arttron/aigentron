-- Default escalation destination: where to notify when a task with no channel
-- of its own (e.g. created in the dashboard) needs input / goes blocked.
-- Nullable/additive: unset = no default channel (dashboard-only escalation).
ALTER TABLE "AppSettings" ADD COLUMN "notifyChannelId" TEXT;
ALTER TABLE "AppSettings" ADD COLUMN "notifyChatId" TEXT;
