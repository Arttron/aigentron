import { describe, expect, it } from 'vitest';
import { titleFromName, appliesTo, cleanTags, isInline, kindFor, mimeFor, promptBlock, safeFileName, search, searchReport, validateMeta, type ResourceEntry } from './resources-core';

const r = (over: Partial<ResourceEntry> = {}): ResourceEntry => ({
  id: 'r1',
  title: 'Kitchen measurements',
  description: 'Wall lengths and window sizes',
  tags: ['kitchen', 'measurements'],
  kind: 'text',
  file: 'kitchen.md',
  originalName: 'kitchen.md',
  mime: 'text/markdown',
  size: 100,
  agents: [],
  source: 'note',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  ...over,
});

describe('kinds and names', () => {
  it('classifies by extension', () => {
    expect(kindFor('MD')).toBe('text');
    expect(kindFor('jpg')).toBe('image');
    expect(kindFor('pdf')).toBe('pdf');
    expect(kindFor('docx')).toBe('file');
    expect(mimeFor('png')).toBe('image/png');
    expect(mimeFor('xyz')).toBe('application/octet-stream');
  });
  it('only images and PDFs are shown inline (nothing that can run script)', () => {
    expect(isInline('image')).toBe(true);
    expect(isInline('pdf')).toBe(true);
    expect(isInline('text')).toBe(false);
    expect(isInline('file')).toBe(false);
  });
  it('makes uploaded names safe, keeps letters of any language, strips paths', () => {
    expect(safeFileName('Quarterly Plan.PDF')).toBe('quarterly-plan.pdf');
    expect(safeFileName('C:\\Users\\me\\Кухня замеры.JPG')).toBe('кухня-замеры.jpg');
    expect(safeFileName('../../etc/passwd')).toBe('passwd');
    expect(safeFileName('###.md')).toBe('file.md');
  });
});

describe('titleFromName', () => {
  it('turns an uploaded name into a readable title', () => {
    expect(titleFromName('../Кухня фото_1.PNG')).toBe('Кухня фото 1');
    expect(titleFromName('C:\\docs\\price_list.pdf')).toBe('price list');
    expect(titleFromName('.hidden')).toBe('.hidden');
    expect(titleFromName('')).toBe('Untitled');
  });
});

describe('metadata', () => {
  it('validates the title and description', () => {
    expect(validateMeta({ title: '  ' })).toMatch(/title/);
    expect(validateMeta({ title: 'x'.repeat(121) })).toMatch(/too long/);
    expect(validateMeta({ title: 'ok', description: 'd'.repeat(601) })).toMatch(/too long/);
    expect(validateMeta({ title: 'ok', description: 'fine' })).toBeNull();
  });
  it('cleans tags: lower-case, de-duplicated, capped', () => {
    expect(cleanTags('Kitchen, kitchen; Wall Paint\nBudget')).toEqual(['kitchen', 'wall-paint', 'budget']);
    expect(cleanTags(Array.from({ length: 30 }, (_, i) => `t${i}`))).toHaveLength(12);
    expect(cleanTags(undefined)).toEqual([]);
  });
});

describe('scope and search', () => {
  it('an empty scope applies to everyone, a scoped one only to the listed agents', () => {
    expect(appliesTo(r(), 'tutor')).toBe(true);
    expect(appliesTo(r({ agents: ['designer'] }), 'designer')).toBe(true);
    expect(appliesTo(r({ agents: ['designer'] }), 'tutor')).toBe(false);
    expect(appliesTo(r({ agents: ['designer'] }), undefined)).toBe(false);
  });
  const list = [r(), r({ id: 'r2', title: 'Budget', description: 'kitchen budget in EUR', tags: ['money'], updatedAt: '2026-10-05T00:00:00.000Z' }), r({ id: 'r3', title: 'Bathroom photo', description: 'tiles', originalName: 'bath.jpg', tags: ['bathroom'], kind: 'image' })];
  it('every word must match; title hits rank higher', () => {
    expect(search(list, 'kitchen').map((x) => x.id)).toEqual(['r1', 'r2']);
    expect(search(list, 'kitchen budget').map((x) => x.id)).toEqual(['r2']);
    expect(search(list, 'nothing-like-this')).toEqual([]);
  });
  it('filters by tag, and returns everything with no query', () => {
    expect(search(list, undefined, 'bathroom').map((x) => x.id)).toEqual(['r3']);
    expect(search(list)).toHaveLength(3);
  });
});

describe('promptBlock', () => {
  const path = (x: ResourceEntry) => `/data/agent/resources/files/${x.file}`;
  it('is empty without resources, and skips ones not meant for this agent', () => {
    expect(promptBlock([], path, 'a')).toBe('');
    expect(promptBlock([r({ agents: ['designer'] })], path, 'tutor')).toBe('');
  });
  it('lists title, description, tags, kind and the path to Read', () => {
    const t = promptBlock([r()], path, 'tutor');
    expect(t).toContain('## Project resources');
    expect(t).toContain('Kitchen measurements — Wall lengths and window sizes [kitchen, measurements] (text) → /data/agent/resources/files/kitchen.md');
  });
  it('caps the list and points to the search tool for the rest', () => {
    const many = Array.from({ length: 30 }, (_, i) => r({ id: `r${i}`, title: `T${i}`, file: `f${i}.md` }));
    const t = promptBlock(many, path, 'a', 25);
    expect(t.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(25);
    expect(t).toContain('+5 more');
    expect(t).toContain('resources_search');
  });
});

describe('searchReport', () => {
  it('says so when nothing matches, and lists paths otherwise', () => {
    expect(searchReport([], () => '')).toBe('No matching resources.');
    expect(searchReport([r()], (x) => `/p/${x.file}`)).toContain('/p/kitchen.md');
  });
});
