-- A knowledge base kept by the platform itself (the administrator's reference): read-only, refreshed from the shipped files.
ALTER TABLE "KnowledgeBase" ADD COLUMN "system" BOOLEAN NOT NULL DEFAULT false;
