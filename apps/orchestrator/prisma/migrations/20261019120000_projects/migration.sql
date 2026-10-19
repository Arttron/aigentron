-- Projects, round 0 (docs/plan-projects-workspace.md §2.3, §2.10): the Project table; the default project
-- (id 'proj_default', slug 'default') adopted from the AppSettings singleton — its repo / verify / notify
-- fields are COPIED, AppSettings keeps them until the next release; every existing task is backfilled into
-- the default project and Task.projectId becomes NOT NULL; Schedule.projectId is optional (null = default).
-- The repository token itself is NOT copied: secrets live in files in the secrets dir, never in this table —
-- the default project only records that token auth is in use (repoAuth = 'token'). Its checkout path
-- (repoPath) is set by the orchestrator at boot from WORKSPACE_REPO_PATH (adopted in place, nothing moves).

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
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
    "archivedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
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

-- AlterTable: every task belongs to a project — nullable, backfilled into the default project, then NOT NULL.
ALTER TABLE "Task" ADD COLUMN     "projectId" TEXT;
UPDATE "Task" SET "projectId" = 'proj_default' WHERE "projectId" IS NULL;
ALTER TABLE "Task" ALTER COLUMN "projectId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Schedule" ADD COLUMN     "projectId" TEXT;

-- CreateIndex
CREATE INDEX "Schedule_projectId_idx" ON "Schedule"("projectId");

-- CreateIndex
CREATE INDEX "Task_projectId_status_idx" ON "Task"("projectId", "status");

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Schedule" ADD CONSTRAINT "Schedule_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;
