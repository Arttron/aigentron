-- Lead agent for tasks that don't pick one (defaults to the PM).
ALTER TABLE "AppSettings" ADD COLUMN "defaultAgent" TEXT DEFAULT 'pm';
