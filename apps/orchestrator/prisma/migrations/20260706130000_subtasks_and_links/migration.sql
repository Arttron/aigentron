-- Subtasks: a task may have a parent produced by decomposition.
ALTER TABLE "Task" ADD COLUMN "parentId" TEXT;
CREATE INDEX "Task_parentId_idx" ON "Task"("parentId");
ALTER TABLE "Task" ADD CONSTRAINT "Task_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Task references: directed link whose target's summary is folded into context.
CREATE TABLE "TaskLink" (
    "id" TEXT NOT NULL,
    "fromTaskId" TEXT NOT NULL,
    "toTaskId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskLink_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TaskLink_fromTaskId_toTaskId_key" ON "TaskLink"("fromTaskId", "toTaskId");
CREATE INDEX "TaskLink_toTaskId_idx" ON "TaskLink"("toTaskId");
ALTER TABLE "TaskLink" ADD CONSTRAINT "TaskLink_fromTaskId_fkey" FOREIGN KEY ("fromTaskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TaskLink" ADD CONSTRAINT "TaskLink_toTaskId_fkey" FOREIGN KEY ("toTaskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;
