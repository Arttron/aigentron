-- Projects, round 0 (docs/plan-projects-workspace.md §2.3, §2.10): the Project table; the default project
-- (id 'proj_default', slug 'default') adopted from the AppSettings singleton — its repo / verify / notify
-- fields are COPIED, AppSettings keeps them until the next release; every existing task is backfilled into
-- the default project and Task.projectId becomes NOT NULL; Schedule.projectId is optional (null = default).
-- The repository token itself is NOT copied: secrets live in files in the secrets dir, never in this table —
-- the default project only records that token auth is in use (repoAuth = 'token'). Its checkout path
-- (repoPath) is set by the orchestrator at boot from WORKSPACE_REPO_PATH (adopted in place, nothing moves).
-- SQLite cannot add a NOT NULL column or a foreign key in place: Task and Schedule are rebuilt the way
-- Prisma generates it (RedefineTables), with the backfilled projectId carried into the new Task table.

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'code',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "repoUrl" TEXT,
    "repoBranch" TEXT NOT NULL DEFAULT 'main',
    "repoSubdir" TEXT,
    "repoAuth" TEXT NOT NULL DEFAULT 'none',
    "repoPath" TEXT,
    "isolation" TEXT,
    "verifyCommands" TEXT,
    "verifyMaxAttempts" INTEGER NOT NULL DEFAULT 2,
    "defaultAgent" TEXT,
    "notifyChannelId" TEXT,
    "notifyChatId" TEXT,
    "archivedAt" DATETIME,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "Project_slug_key" ON "Project"("slug");

-- The default project: from the settings row when the installation has one …
INSERT INTO "Project" ("id", "slug", "name", "kind", "isDefault", "repoUrl", "repoBranch", "repoSubdir", "repoAuth", "verifyCommands", "verifyMaxAttempts", "defaultAgent", "notifyChannelId", "notifyChatId", "createdAt", "updatedAt")
SELECT 'proj_default', 'default', 'Default', 'code', true,
       NULLIF(s."repoUrl", ''),
       COALESCE(NULLIF(s."repoBranch", ''), 'main'),
       NULLIF(s."workspaceSubdir", ''),
       CASE WHEN s."githubToken" IS NOT NULL AND s."githubToken" <> '' THEN 'token' ELSE 'none' END,
       NULLIF(s."verifyCommands", ''),
       COALESCE(s."verifyMaxAttempts", 2),
       NULLIF(s."defaultAgent", ''),
       NULLIF(s."notifyChannelId", ''),
       NULLIF(s."notifyChatId", ''),
       CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "AppSettings" s
WHERE s."id" = 'singleton';
-- … or bare, on a database the orchestrator has never started on (no settings row yet).
INSERT INTO "Project" ("id", "slug", "name", "kind", "isDefault", "repoBranch", "repoAuth", "verifyMaxAttempts", "createdAt", "updatedAt")
SELECT 'proj_default', 'default', 'Default', 'code', true, 'main', 'none', 2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM "Project" WHERE "id" = 'proj_default');

-- Backfill on the OLD Task table (nullable column), so the rebuild below can carry a NOT NULL value over.
ALTER TABLE "Task" ADD COLUMN "projectId" TEXT;
UPDATE "Task" SET "projectId" = 'proj_default' WHERE "projectId" IS NULL;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Schedule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "cron" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "kind" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "agentName" TEXT,
    "channelId" TEXT,
    "chatId" TEXT,
    "taskMode" TEXT NOT NULL DEFAULT 'same',
    "taskId" TEXT,
    "projectId" TEXT,
    "quietStart" TEXT,
    "quietEnd" TEXT,
    "nextRunAt" DATETIME,
    "lastRunAt" DATETIME,
    "lastStatus" TEXT,
    "lastError" TEXT,
    "createdBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Schedule_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Schedule_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Schedule" ("agentName", "channelId", "chatId", "createdAt", "createdBy", "cron", "enabled", "id", "kind", "lastError", "lastRunAt", "lastStatus", "name", "nextRunAt", "quietEnd", "quietStart", "taskId", "taskMode", "text", "timezone", "updatedAt") SELECT "agentName", "channelId", "chatId", "createdAt", "createdBy", "cron", "enabled", "id", "kind", "lastError", "lastRunAt", "lastStatus", "name", "nextRunAt", "quietEnd", "quietStart", "taskId", "taskMode", "text", "timezone", "updatedAt" FROM "Schedule";
DROP TABLE "Schedule";
ALTER TABLE "new_Schedule" RENAME TO "Schedule";
CREATE UNIQUE INDEX "Schedule_name_key" ON "Schedule"("name");
CREATE INDEX "Schedule_enabled_nextRunAt_idx" ON "Schedule"("enabled", "nextRunAt");
CREATE INDEX "Schedule_taskId_idx" ON "Schedule"("taskId");
CREATE INDEX "Schedule_projectId_idx" ON "Schedule"("projectId");
CREATE TABLE "new_Task" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "prompt" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "titleState" TEXT NOT NULL DEFAULT 'auto',
    "kind" TEXT NOT NULL DEFAULT 'task',
    "status" TEXT NOT NULL DEFAULT 'queued',
    "branch" TEXT,
    "worktreePath" TEXT,
    "agentName" TEXT,
    "prUrl" TEXT,
    "pushedTo" TEXT,
    "error" TEXT,
    "createdById" TEXT,
    "parentId" TEXT,
    "projectId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "createdByChannel" TEXT,
    "providerOverride" TEXT,
    "awaitingSubtasks" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "Task_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Task_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Task" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Task_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Task" ("agentName", "awaitingSubtasks", "branch", "createdAt", "createdByChannel", "createdById", "error", "id", "kind", "parentId", "projectId", "prUrl", "prompt", "providerOverride", "pushedTo", "status", "title", "titleState", "updatedAt", "worktreePath") SELECT "agentName", "awaitingSubtasks", "branch", "createdAt", "createdByChannel", "createdById", "error", "id", "kind", "parentId", "projectId", "prUrl", "prompt", "providerOverride", "pushedTo", "status", "title", "titleState", "updatedAt", "worktreePath" FROM "Task";
DROP TABLE "Task";
ALTER TABLE "new_Task" RENAME TO "Task";
CREATE INDEX "Task_status_idx" ON "Task"("status");
CREATE INDEX "Task_createdById_idx" ON "Task"("createdById");
CREATE INDEX "Task_parentId_createdAt_idx" ON "Task"("parentId", "createdAt");
CREATE INDEX "Task_kind_idx" ON "Task"("kind");
CREATE INDEX "Task_projectId_status_idx" ON "Task"("projectId", "status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
