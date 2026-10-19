-- Knowledge bases scoped to projects (docs/plan-projects-workspace.md §2.7): `KnowledgeBase.projectId`, null = a GLOBAL base
-- (visible to the tasks of every project — what every existing base is: nothing is backfilled, nothing changes for them).
-- A base of a deleted project becomes global (ON DELETE SET NULL) — a project's deletion never destroys knowledge by itself.
-- Names stay globally unique: the kb_* tools address a base by name.

-- AlterTable
ALTER TABLE "KnowledgeBase" ADD COLUMN     "projectId" TEXT;

-- CreateIndex
CREATE INDEX "KnowledgeBase_projectId_idx" ON "KnowledgeBase"("projectId");

-- AddForeignKey
ALTER TABLE "KnowledgeBase" ADD CONSTRAINT "KnowledgeBase_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;
