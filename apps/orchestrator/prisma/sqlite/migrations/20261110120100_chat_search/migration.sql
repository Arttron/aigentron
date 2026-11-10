-- Search in chats: the words of a message as the index keeps them (stemmed by the app), and an FTS5 index over them (kept in step by triggers).
ALTER TABLE "AgentEvent" ADD COLUMN "searchText" TEXT NOT NULL DEFAULT '';
CREATE VIRTUAL TABLE "agent_event_fts" USING fts5("searchText", content='AgentEvent', content_rowid='rowid', tokenize='unicode61 remove_diacritics 0');
INSERT INTO "agent_event_fts"("agent_event_fts") VALUES ('rebuild');
CREATE TRIGGER "agent_event_fts_ai" AFTER INSERT ON "AgentEvent" BEGIN
  INSERT INTO "agent_event_fts"(rowid, "searchText") VALUES (new.rowid, new."searchText");
END;
CREATE TRIGGER "agent_event_fts_ad" AFTER DELETE ON "AgentEvent" BEGIN
  INSERT INTO "agent_event_fts"("agent_event_fts", rowid, "searchText") VALUES ('delete', old.rowid, old."searchText");
END;
CREATE TRIGGER "agent_event_fts_au" AFTER UPDATE OF "searchText" ON "AgentEvent" BEGIN
  INSERT INTO "agent_event_fts"("agent_event_fts", rowid, "searchText") VALUES ('delete', old.rowid, old."searchText");
  INSERT INTO "agent_event_fts"(rowid, "searchText") VALUES (new.rowid, new."searchText");
END;
