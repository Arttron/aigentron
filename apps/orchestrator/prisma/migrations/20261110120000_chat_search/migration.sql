-- Search in chats: the words of a message as the index keeps them (stemmed by the app), and a full-text index over them.
ALTER TABLE "AgentEvent" ADD COLUMN "searchText" TEXT NOT NULL DEFAULT '';
CREATE INDEX "AgentEvent_searchText_fts" ON "AgentEvent" USING GIN (to_tsvector('simple', "searchText"));
