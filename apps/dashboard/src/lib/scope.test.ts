import { describe, expect, it } from 'vitest';
import { filterByScope, hasScopes, initialScope, isScope, libraryLine, scopeHelp, scopeLabel, scopedHref, targetProject } from './scope';

const P = [
  { slug: 'default', name: 'Default' },
  { slug: 'kukhnya', name: 'Кухня' },
];
const items = [
  { id: 1, project: null },
  { id: 2 },
  { id: 3, project: 'kukhnya' },
  { id: 4, project: 'other' },
];

describe('hasScopes', () => {
  it('needs more than one project', () => {
    expect(hasScopes(null)).toBe(false);
    expect(hasScopes([P[0]])).toBe(false);
    expect(hasScopes(P)).toBe(true);
  });
});

describe('filterByScope', () => {
  it('all keeps everything', () => expect(filterByScope(items, 'all')).toHaveLength(4));
  it('global = no project (null or absent)', () => expect(filterByScope(items, 'global').map((i) => i.id)).toEqual([1, 2]));
  it('a slug = that project only', () => expect(filterByScope(items, 'kukhnya').map((i) => i.id)).toEqual([3]));
});

describe('scopeLabel / scopeHelp', () => {
  it('global and project names', () => {
    expect(scopeLabel(null, P)).toBe('global');
    expect(scopeLabel('kukhnya', P)).toBe('Кухня');
    expect(scopeLabel('gone', P)).toBe('gone');
  });
  it('says who sees it', () => {
    expect(scopeHelp(null, P)).toBe('Every agent of every project sees it.');
    expect(scopeHelp('kukhnya', P)).toBe('Only agents working on Кухня see it.');
  });
});

describe('initialScope', () => {
  it('the link wins over the remembered choice', () => expect(initialScope('?project=kukhnya', 'global', P)).toBe('kukhnya'));
  it('falls back to the remembered one, then all', () => {
    expect(initialScope('', 'global', P)).toBe('global');
    expect(initialScope('', null, P)).toBe('all');
  });
  it('ignores unknown projects', () => {
    expect(initialScope('?project=nope', 'gone', P)).toBe('all');
    expect(isScope('nope', P)).toBe(false);
    expect(isScope('all', P)).toBe(true);
  });
});

describe('targetProject', () => {
  it('uses the scope, or the Add-to choice under all', () => {
    expect(targetProject('kukhnya', '')).toBe('kukhnya');
    expect(targetProject('global', 'kukhnya')).toBeNull();
    expect(targetProject('all', 'kukhnya')).toBe('kukhnya');
    expect(targetProject('all', '')).toBeNull();
  });
});

describe('links and counts', () => {
  it('builds the filtered link', () => expect(scopedHref('/resources', 'a b')).toBe('/resources?project=a%20b'));
  it('library line', () => {
    expect(libraryLine({ resources: 3, knowledge: 1 })).toBe('Resources: 3 · Knowledge bases: 1');
    expect(libraryLine({ resources: 2 })).toBe('Resources: 2 · Knowledge bases: 0');
    expect(libraryLine(undefined)).toBe('');
  });
});
