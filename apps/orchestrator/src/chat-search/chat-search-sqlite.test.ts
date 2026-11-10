import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { eventSearchText, fts5Query, parseQuery } from './search-core';

// better-sqlite3 is the Prisma adapter's own dependency: loaded through it
const Database = createRequire(createRequire(import.meta.url).resolve('@prisma/adapter-better-sqlite3'))('better-sqlite3') as typeof import('better-sqlite3');
type Db = InstanceType<typeof Database>;

/** The real SQLite migration (FTS5 table + triggers) run against a small table: the index must follow inserts, updates and deletes, and answer the service's query. */
describe('the SQLite full-text index (migration SQL)', () => {
  const migration = readFileSync(join(import.meta.dirname, '../../prisma/sqlite/migrations/20261110120100_chat_search/migration.sql'), 'utf8');
  const make = () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE "AgentEvent" ("id" TEXT NOT NULL PRIMARY KEY, "taskId" TEXT NOT NULL, "kind" TEXT NOT NULL, "text" TEXT NOT NULL)`);
    db.exec(`INSERT INTO "AgentEvent" ("id","taskId","kind","text") VALUES ('old','t0','result','стара запись про бонусы')`);
    db.exec(migration);
    return db;
  };
  const put = (db: Db, id: string, kind: string, text: string) =>
    db.prepare(`INSERT INTO "AgentEvent" ("id","taskId","kind","text","searchText") VALUES (?,?,?,?,?)`).run(id, 't1', kind, text, eventSearchText(kind, text));
  const find = (db: Db, q: string, kinds = ['result', 'prompt']) => {
    const p = parseQuery(q);
    return db
      .prepare(`SELECT e."id" AS id, bm25("agent_event_fts") AS rank FROM "agent_event_fts" JOIN "AgentEvent" e ON e.rowid = "agent_event_fts".rowid WHERE "agent_event_fts" MATCH ? AND e."kind" IN (${kinds.map(() => '?').join(',')}) ORDER BY rank`)
      .all(fts5Query(p.terms, p.excluded), ...kinds) as { id: string; rank: number }[];
  };

  it('finds a message by any form of its words, ANDs the words, and honours an exclusion', () => {
    const db = make();
    put(db, 'a', 'result', 'Налоговый бонус в Литве для новой компании');
    put(db, 'b', 'result', 'Гранты в Литве под EdTech');
    put(db, 'c', 'prompt', 'Какие бонусы в Литве?');
    expect(find(db, 'литва').map((r) => r.id).sort()).toEqual(['a', 'b', 'c']);
    expect(find(db, 'литва бонусы').map((r) => r.id).sort()).toEqual(['a', 'c']);
    expect(find(db, 'литва -бонусы').map((r) => r.id)).toEqual(['b']);
    expect(find(db, 'литва', ['prompt']).map((r) => r.id)).toEqual(['c']);
  });
  it('an earlier row is indexed once the backfill writes its searchText (update trigger), and a deleted row is gone (delete trigger)', () => {
    const db = make();
    expect(find(db, 'бонусы')).toEqual([]);
    db.prepare(`UPDATE "AgentEvent" SET "searchText" = ? WHERE "id" = 'old'`).run(eventSearchText('result', 'стара запись про бонусы'));
    expect(find(db, 'бонусы').map((r) => r.id)).toEqual(['old']);
    db.prepare(`DELETE FROM "AgentEvent" WHERE "id" = 'old'`).run();
    expect(find(db, 'бонусы')).toEqual([]);
    expect(db.prepare(`INSERT INTO "agent_event_fts"("agent_event_fts") VALUES ('integrity-check')`).run()).toBeTruthy();
  });
});
