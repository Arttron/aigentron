-- A subtask that waits for sibling subtasks (`after`): JSON array of ids, "[]" = not waiting.
ALTER TABLE "Task" ADD COLUMN "waitingFor" TEXT NOT NULL DEFAULT '[]';
