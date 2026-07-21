-- AlterTable
ALTER TABLE "AppSettings" ADD COLUMN     "verifyCommands" TEXT,
ADD COLUMN     "verifyMaxAttempts" INTEGER NOT NULL DEFAULT 2;
