-- When a request that waits for a person reaches the chats: delay in seconds (0 = at once, -1 = never) and whether an unattended dashboard sends it at once.
ALTER TABLE "AppSettings" ADD COLUMN "approvalChatDelay" INTEGER NOT NULL DEFAULT 10;
ALTER TABLE "AppSettings" ADD COLUMN "approvalChatNobodyAtOnce" BOOLEAN NOT NULL DEFAULT true;
