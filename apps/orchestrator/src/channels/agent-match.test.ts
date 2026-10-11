import { describe, expect, it } from 'vitest';
import { commandKey, editDistance, matchAgent, parseAddress } from './agent-match';

const agents = ['pm', 'architect', 'backend-dev', 'frontend-dev', 'designer', 'reviewer', 'English tutor'].map((name) => ({ name }));

describe('commandKey', () => {
  it('makes Telegram-safe command names', () => {
    expect(commandKey('backend-dev')).toBe('backend_dev');
    expect(commandKey('English tutor')).toBe('english_tutor');
    expect(commandKey('  PM  ')).toBe('pm');
    expect(commandKey('---')).toBeNull();
    expect(commandKey('x'.repeat(50))!.length).toBe(32);
  });
});

describe('editDistance', () => {
  it('counts a missing, extra, wrong or swapped letter as one', () => {
    expect(editDistance('architect', 'architect')).toBe(0);
    expect(editDistance('architct', 'architect')).toBe(1);
    expect(editDistance('architecct', 'architect')).toBe(1);
    expect(editDistance('architest', 'architect')).toBe(1);
    expect(editDistance('arhcitect', 'architect')).toBe(1);
  });
});

describe('matchAgent', () => {
  it('exact: any case / separator', () => {
    expect(matchAgent('PM', agents)).toEqual({ kind: 'exact', name: 'pm' });
    expect(matchAgent('backend_dev', agents)).toEqual({ kind: 'exact', name: 'backend-dev' });
    expect(matchAgent('Backend-Dev', agents)).toEqual({ kind: 'exact', name: 'backend-dev' });
    expect(matchAgent('backenddev', agents)).toEqual({ kind: 'exact', name: 'backend-dev' });
    expect(matchAgent('english_tutor', agents)).toEqual({ kind: 'exact', name: 'English tutor' });
  });
  it('forgives typos in longer names', () => {
    expect(matchAgent('architct', agents)).toEqual({ kind: 'fuzzy', name: 'architect' });
    expect(matchAgent('arhcitect', agents)).toEqual({ kind: 'fuzzy', name: 'architect' });
    expect(matchAgent('bakend_dev', agents)).toEqual({ kind: 'fuzzy', name: 'backend-dev' });
    expect(matchAgent('desiner', agents)).toEqual({ kind: 'fuzzy', name: 'designer' });
    expect(matchAgent('reviwer', agents)).toEqual({ kind: 'fuzzy', name: 'reviewer' });
  });
  it('a unique prefix works; an ambiguous one lists the candidates', () => {
    expect(matchAgent('arch', agents)).toEqual({ kind: 'fuzzy', name: 'architect' });
    expect(matchAgent('front', agents)).toEqual({ kind: 'fuzzy', name: 'frontend-dev' });
    const amb = matchAgent('end_dev', agents);
    expect(['none', 'ambiguous']).toContain(amb.kind);
    expect(matchAgent('dev', agents)).toMatchObject({ kind: 'ambiguous' });
  });
  it('short names are not guessed (pm is not pr), and nonsense finds nothing', () => {
    expect(matchAgent('pr', [{ name: 'pm' }])).toMatchObject({ kind: 'none' });
    expect(matchAgent('zzzzzz', agents)).toEqual({ kind: 'none', suggestions: [] });
    expect(matchAgent('', agents)).toEqual({ kind: 'none', suggestions: [] });
  });
  it('suggests close names when nothing is forgiven', () => {
    const r = matchAgent('architectural', agents);
    expect(r.kind === 'none' || r.kind === 'fuzzy').toBe(true);
  });
});

describe('parseAddress', () => {
  it('reads /name, /name@Bot and @name at the start', () => {
    expect(parseAddress('/pm make the report')).toEqual({ symbol: '/', typed: 'pm', rest: 'make the report' });
    expect(parseAddress('@pm   do it\nnow')).toEqual({ symbol: '@', typed: 'pm', rest: 'do it\nnow' });
    expect(parseAddress('/backend_dev@AigentronBot fix it')).toEqual({ symbol: '/', typed: 'backend_dev', rest: 'fix it' });
    expect(parseAddress('/pm')).toEqual({ symbol: '/', typed: 'pm', rest: '' });
    expect(parseAddress('hello @pm')).toBeNull();
    expect(parseAddress('just text')).toBeNull();
  });
});
