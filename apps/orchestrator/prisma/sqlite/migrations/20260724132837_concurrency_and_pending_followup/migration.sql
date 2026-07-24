-- CreateTable
CREATE TABLE "PendingFollowUp" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "attachments" TEXT NOT NULL DEFAULT '[]',
    "references" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PendingFollowUp_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AppSettings" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'singleton',
    "approvalTimeoutSeconds" INTEGER NOT NULL DEFAULT 300,
    "verifyCommands" TEXT,
    "verifyMaxAttempts" INTEGER NOT NULL DEFAULT 2,
    "concurrency" INTEGER NOT NULL DEFAULT 2,
    "debugMode" BOOLEAN NOT NULL DEFAULT false,
    "agentInstructions" TEXT NOT NULL DEFAULT 'Before changing anything, inspect the project in your working directory: list the files and read the README and key config files to understand its structure and conventions. Then implement the task with minimal, focused changes that match the existing style.',
    "repoUrl" TEXT,
    "repoBranch" TEXT NOT NULL DEFAULT 'main',
    "githubToken" TEXT,
    "workspaceSubdir" TEXT,
    "defaultProvider" TEXT,
    "defaultAgent" TEXT DEFAULT 'pm',
    "notifyChannelId" TEXT,
    "notifyChatId" TEXT,
    "lastSkillConsolidationAt" DATETIME,
    "skillConsolidationIntervalDays" INTEGER NOT NULL DEFAULT 7,
    "skillConsolidationAgent" TEXT DEFAULT 'architect',
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_AppSettings" ("agentInstructions", "approvalTimeoutSeconds", "debugMode", "defaultAgent", "defaultProvider", "githubToken", "id", "lastSkillConsolidationAt", "notifyChannelId", "notifyChatId", "repoBranch", "repoUrl", "skillConsolidationAgent", "skillConsolidationIntervalDays", "updatedAt", "verifyCommands", "verifyMaxAttempts", "workspaceSubdir") SELECT "agentInstructions", "approvalTimeoutSeconds", "debugMode", "defaultAgent", "defaultProvider", "githubToken", "id", "lastSkillConsolidationAt", "notifyChannelId", "notifyChatId", "repoBranch", "repoUrl", "skillConsolidationAgent", "skillConsolidationIntervalDays", "updatedAt", "verifyCommands", "verifyMaxAttempts", "workspaceSubdir" FROM "AppSettings";
DROP TABLE "AppSettings";
ALTER TABLE "new_AppSettings" RENAME TO "AppSettings";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "PendingFollowUp_taskId_createdAt_idx" ON "PendingFollowUp"("taskId", "createdAt");
