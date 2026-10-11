-- Task kind (task | discussion) for the task-type filter.
ALTER TABLE "Task" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'task';
UPDATE "Task" SET "kind" = 'discussion' WHERE "title" LIKE 'Discussion: %';
CREATE INDEX "Task_kind_idx" ON "Task"("kind");
