import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isValidScheduleName, validateCron } from '../schedules/schedule-core';
import { cleanTags, validateMeta } from '../resources/resources-core';

/** The shipped packs are content, and content rots silently: check every reference resolves. */
const AGENT_DIR = join(__dirname, '..', '..', '..', '..', 'agent');
const PACKS = join(AGENT_DIR, 'packs');
const packNames = existsSync(PACKS) ? readdirSync(PACKS).filter((n) => existsSync(join(PACKS, n, 'pack.json'))) : [];

const front = (raw: string) => {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  return m ? { head: m[1]!, body: m[2]!.trim() } : null;
};
const read = (p: string) => readFileSync(p, 'utf8');

describe('shipped packs', () => {
  it('there are packs to check', () => {
    expect(packNames.sort()).toEqual(['development', 'english', 'renovation']);
  });

  describe.each(packNames)('pack %s', (name) => {
    const dir = join(PACKS, name);
    const m = JSON.parse(read(join(dir, 'pack.json'))) as {
      title: string;
      description: string;
      agents?: string[];
      catalogAgents?: string[];
      skills?: string[];
      resources?: { file: string; title: string; description?: string; tags?: string[] }[];
      schedules?: { name: string; cron: string; kind: string; agent: string; text: string }[];
      after?: string;
    };

    it('has a title, a description and next steps', () => {
      expect(m.title.length).toBeGreaterThan(3);
      expect(m.description.length).toBeGreaterThan(40);
      expect((m.after ?? '').length).toBeGreaterThan(20);
    });

    it('its agent files exist with a description, a body and a safe name', () => {
      for (const a of m.agents ?? []) {
        expect(a, a).toMatch(/^[a-z0-9][a-z0-9-]*$/);
        const f = front(read(join(dir, 'agents', `${a}.md`)));
        expect(f, `${a} frontmatter`).not.toBeNull();
        expect(f!.head, a).toMatch(/^description:\s*\S/m);
        expect(f!.body.length, `${a} body`).toBeGreaterThan(300);
        expect(f!.head, `${a} must not name itself`).not.toMatch(/^name:/m);
      }
    });

    it('catalog agents exist in the shared catalog', () => {
      for (const a of m.catalogAgents ?? []) expect(existsSync(join(AGENT_DIR, 'catalog', 'agents', `${a}.md`)), a).toBe(true);
    });

    it('skills exist, have a description, and do not collide with shipped skills', () => {
      for (const s of m.skills ?? []) {
        const f = front(read(join(dir, 'skills', `${s}.md`)));
        expect(f, s).not.toBeNull();
        expect(f!.head, s).toMatch(/^description:\s*\S/m);
        expect(existsSync(join(AGENT_DIR, 'skills', 'core', `${s}.md`)), `${s} shadows a core skill`).toBe(false);
      }
    });

    it('agents only reference skills that exist (shipped, learned or in the pack)', () => {
      const known = new Set<string>(m.skills ?? []);
      for (const f of readdirSync(join(AGENT_DIR, 'skills', 'core')).filter((x) => x.endsWith('.md'))) known.add(f.replace(/\.md$/, ''));
      for (const a of m.agents ?? []) {
        const line = front(read(join(dir, 'agents', `${a}.md`)))!.head.match(/^skills:\s*(.+)$/m)?.[1];
        for (const s of (line ?? '').split(',').map((x) => x.trim()).filter((x) => x && x !== 'none')) expect(known.has(s), `${a} → skill ${s}`).toBe(true);
      }
    });

    it('library resources exist and carry usable metadata', () => {
      for (const r of m.resources ?? []) {
        expect(existsSync(join(dir, r.file)), r.file).toBe(true);
        expect(validateMeta({ title: r.title, description: r.description }), r.title).toBeNull();
        expect((r.description ?? '').length, `${r.title} needs a real description (agents choose by it)`).toBeGreaterThan(30);
        expect(cleanTags(r.tags).length, `${r.title} tags`).toBeGreaterThan(0);
      }
    });

    it('prepared schedules are valid task schedules for agents the pack installs', () => {
      const agents = new Set([...(m.agents ?? []), ...(m.catalogAgents ?? [])]);
      for (const s of m.schedules ?? []) {
        expect(s.kind, s.name).toBe('task');
        expect(agents.has(s.agent), `${s.name} → ${s.agent}`).toBe(true);
        expect(validateCron(s.cron, 'UTC'), s.name).toBeNull();
        expect(s.text.length, s.name).toBeGreaterThan(30);
        expect(isValidScheduleName(s.name), `${s.name} would be refused by the scheduler`).toBe(true);
      }
    });
  });
});
