-- Knowledge bases scoped to projects (docs/plan-projects-workspace.md §2.7): `KnowledgeBase.projectId`, null = a GLOBAL base
-- (visible to the tasks of every project — what every existing base is: nothing is backfilled, nothing changes for them).
-- A base of a deleted project becomes global (ON DELETE SET NULL) — a project's deletion never destroys knowledge by itself.
-- Names stay globally unique: the kb_* tools address a base by name.
-- SQLite cannot add a foreign key in place: KnowledgeBase is rebuilt the way Prisma generates it (RedefineTables); the
-- documents and chunks keep pointing at it by name (foreign keys are off while the table is swapped).

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_KnowledgeBase" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "agents" JSONB NOT NULL,
    "chunking" JSONB NOT NULL,
    "embedProvider" TEXT,
    "embedModel" TEXT,
    "embedDim" INTEGER,
    "agentWrite" BOOLEAN NOT NULL DEFAULT false,
    "projectId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "KnowledgeBase_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_KnowledgeBase" ("agentWrite", "agents", "chunking", "createdAt", "description", "embedDim", "embedModel", "embedProvider", "id", "name", "updatedAt") SELECT "agentWrite", "agents", "chunking", "createdAt", "description", "embedDim", "embedModel", "embedProvider", "id", "name", "updatedAt" FROM "KnowledgeBase";
DROP TABLE "KnowledgeBase";
ALTER TABLE "new_KnowledgeBase" RENAME TO "KnowledgeBase";
CREATE UNIQUE INDEX "KnowledgeBase_name_key" ON "KnowledgeBase"("name");
CREATE INDEX "KnowledgeBase_projectId_idx" ON "KnowledgeBase"("projectId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
