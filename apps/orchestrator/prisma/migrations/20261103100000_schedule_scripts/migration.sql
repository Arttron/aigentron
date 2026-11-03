-- Scheduled scripts: what the last run printed, its time limit, and when to post to the chat.
ALTER TABLE "Schedule" ADD COLUMN "lastOutput" TEXT;
ALTER TABLE "Schedule" ADD COLUMN "timeoutSec" INTEGER;
ALTER TABLE "Schedule" ADD COLUMN "notifyOn" TEXT NOT NULL DEFAULT 'always';
