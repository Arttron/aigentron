-- Approval mode per level: a task (its subtasks follow it) and a project. Null = follow the next level up (project, then the global setting).
ALTER TABLE "Project" ADD COLUMN "approvalMode" TEXT;
ALTER TABLE "Task" ADD COLUMN "approvalMode" TEXT;
