-- Slots of the chat lane; 0 = automatic.
ALTER TABLE "AppSettings" ADD COLUMN "chatConcurrency" INTEGER NOT NULL DEFAULT 0;
