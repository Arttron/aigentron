import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Bm25Index, chunkText, cleanChunking } from './kb-core';
import { ADMIN_REFERENCE_CHUNKING, buildReferenceIndex, splitGuide } from './admin-reference-core';

describe('splitGuide', () => {
  it('cuts by ## sections, keeps the overview and skips fenced ## lines', () => {
    const md = '---\ndescription: x\n---\n# Title\nIntro text that is long enough to count as content.\n\n## First\nBody of the first section is here.\n\n```\n## not a heading\n```\n\n## Second `code`\nBody of the second section is here.\n';
    const docs = splitGuide('guide.md', md);
    expect(docs.map((d) => d.title)).toEqual(['guide: Overview', 'guide: First', 'guide: Second code']);
    expect(docs[1]!.text).toContain('## not a heading');
    expect(docs[0]!.source).toBe('skills/core/admin/guide.md');
  });
  it('drops a section that is only its heading', () => {
    expect(splitGuide('g.md', '## Empty\n\n## Real\nSomething real and long enough to keep.')).toHaveLength(1);
  });
});

describe('buildReferenceIndex', () => {
  it('groups sections by file, sorted, and tells how to search', () => {
    const idx = buildReferenceIndex(['b: Two', 'a: One', 'a: Alpha']);
    expect(idx).toContain('kb_search');
    expect(idx).toContain('ONCE');
    expect(idx.indexOf('**a**')).toBeLessThan(idx.indexOf('**b**'));
    expect(idx).toContain('- **a**: Alpha · One');
  });
});

// Retrieval quality on the REAL guides, the way the administrator meets it: the passages attached to its message are the top hits of the base built
// with ITS chunking (small passages, shown whole). For each question the needle (a phrase of the right answer) must be inside the first hits.
const dir = join(__dirname, '../../../../agent/skills/core/admin');
const docs = readdirSync(dir)
  .filter((f) => f.endsWith('.md'))
  .flatMap((f) => splitGuide(f, readFileSync(join(dir, f), 'utf8')));
const rows = docs.flatMap((d) => chunkText(d.text, cleanChunking(ADMIN_REFERENCE_CHUNKING)).map((c) => ({ doc: d.title, heading: c.heading, text: c.text })));
const index = new Bm25Index();
for (const r of rows) index.add(`${r.doc} ${r.heading}`, r.text);
const hits = (q: string, n: number) => index.search(q, n).map((s) => rows[s.idx]!);
/** Does one of the first `n` passages contain the needle (the fact the answer rests on)? */
const found = (q: string, needle: RegExp, n = 4) => hits(q, n).some((h) => needle.test(`${h.doc}\n${h.text}`));

describe('the administrator reference answers typical questions (retrieval)', () => {
  const cases: [string, RegExp][] = [
    ['Where do I set the model that answers quick questions, and what does "Just a question" do?', /Questions\*: the model that answers tasks started as/i],
    ['how do I connect the browser extension', /\*\*Extension\*\* tab:/i],
    ['what do I do when a newer version of the extension is available', /Update the extension/i],
    ['where are the run limits and the ceiling approval', /Run limits\*:/i],
    ['what does propose_agent need', /Agent file format/i],
    ['how to set the translate language of the translate button', /Translation\* \(per browser\)/i],
    ['telegram channel: what does a plain message start, a task or a question', /A plain message starts/i],
    ['voice add-on whisper piper enable', /\*\*Voice\*\* tab:/i],
    ['escalation ladder for an agent and fallback providers', /Escalation ladder/i],
    ['text compression and filtering settings', /Compression and filtering\*:/i],
    ['stats page escalations and questions', /\*\*Escalations\*\*/i],
    ['how do I create a new agent from a template', /catalog_list/i],
  ];
  it.each(cases)('"%s"', (q, needle) => {
    expect(found(q, needle), `${q} → ${hits(q, 4).map((h) => h.doc).join(' | ')}`).toBe(true);
  });
  it('the passages are small enough to be shown whole and every guide produced documents', () => {
    expect(new Set(docs.map((d) => d.source)).size).toBeGreaterThanOrEqual(4);
    expect(Math.max(...rows.map((r) => r.text.length))).toBeLessThanOrEqual(1700);
  });
});
