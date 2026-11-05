-- Clearing the checkouts of finished work: the mode and the days to wait after a task is done.
ALTER TABLE "AppSettings" ADD COLUMN "cleanupMode" TEXT NOT NULL DEFAULT 'merged_or_done';
ALTER TABLE "AppSettings" ADD COLUMN "cleanupDoneDays" INTEGER NOT NULL DEFAULT 3;
