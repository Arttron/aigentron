-- Per-task provider (model endpoint) override, set via a channel's /model command.
ALTER TABLE "Task" ADD COLUMN "providerOverride" TEXT;
