-- Task names generated from the context. Tasks that already exist keep their titles.
ALTER TABLE "Task" ADD COLUMN "titleState" TEXT NOT NULL DEFAULT 'auto';
UPDATE "Task" SET "titleState" = 'manual';
