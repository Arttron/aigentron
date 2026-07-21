-- Fan-in flag: parent is resumed once all its subtasks finish.
ALTER TABLE "Task" ADD COLUMN "awaitingSubtasks" BOOLEAN NOT NULL DEFAULT false;
