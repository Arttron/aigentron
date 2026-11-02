import { describe, expect, it } from 'vitest';
import { compressText, DEFAULT_COMPRESSION, normalizeCompression, validRulePattern } from './compress';

const cfg = { ...DEFAULT_COMPRESSION, minChars: 0 };

describe('compressText', () => {
  it('leaves short texts and a disabled config alone', () => {
    const t = 'hello\n\n\n\nworld';
    expect(compressText(t).text).toBe(t);
    expect(compressText(t, { ...cfg, enabled: false }).text).toBe(t);
  });
  it('collapses blank lines and spaces', () => {
    const r = compressText('a b      \n\n\n\n\nc', cfg);
    expect(r.text).toBe('a b\n\nc');
    expect(r.saved.whitespace).toBeGreaterThan(0);
  });
  it('folds equal lines in a row', () => {
    expect(compressText('x\nretrying request\nretrying request\nretrying request\nretrying request\ny', cfg).text).toBe('x\nretrying request (×4)\ny');
    expect(compressText('a\na\nb', cfg).text).toBe('a\na\nb');
  });
  it('drops quoted replies and signatures but keeps the new text', () => {
    const mail = 'Thanks, do it.\n\nOn Mon, 3 Jan 2026 at 10:00, Bob <b@x.io> wrote:\n> old text\n> more\n';
    expect(compressText(mail, cfg).text).toBe('Thanks, do it.\n\n[… 4 quoted lines left out …]');
    expect(compressText('Hi\n-- \nBob\nCEO', cfg).text).toContain('Hi');
    expect(compressText('Hi\n--\nBob\nCEO', cfg).text).toContain('CEO'); // a bare "--" is not a signature
    expect(compressText('Hi\n-- \nBob Builder\nChief Executive Officer\nBuilders Inc, 1 Main Street\n+1 555 0100', cfg).text).not.toContain('Chief');
    expect(compressText('Do it please\nSent from my iPhone', cfg).text).toContain('Do it');
    expect(compressText('a\n> the first quoted line of the old mail\n> the second quoted line of the old mail\n> the third quoted line of the old mail\n> the fourth quoted line of the old mail\nb', cfg).text).toBe('a\n[… 4 quoted lines left out …]\nb');
  });
  it('shortens base64, data URIs and hex', () => {
    const b64 = 'A'.repeat(400);
    expect(compressText(`img ${b64} end`, cfg).text).toBe('img [encoded data, 400 chars] end');
    expect(compressText(`<img src="data:image/png;base64,${'Qk'.repeat(100)}">`, cfg).text).toContain('[data URI,');
    expect(compressText('hash ' + 'ab'.repeat(120), cfg).text).toContain('[hex string, 240 chars]');
  });
  it('keeps the head and the tail of a long log', () => {
    const log = Array.from({ length: 200 }, (_, i) => `2026-01-01 10:00:${String(i % 60).padStart(2, '0')} INFO step ${i}`).join('\n');
    const r = compressText(`Result:\n${log}\nDone.`, { ...cfg, logKeepHead: 5, logKeepTail: 5 });
    expect(r.text).toContain('step 0');
    expect(r.text).toContain('step 199');
    expect(r.text).not.toContain('step 100');
    expect(r.text).toContain('190 log lines left out');
    expect(r.text.startsWith('Result:')).toBe(true);
    expect(r.text.endsWith('Done.')).toBe(true);
  });
  it('caps the length with head and tail', () => {
    const r = compressText('word '.repeat(1000), { ...cfg, maxChars: 1000 });
    expect(r.after).toBeLessThan(1100);
    expect(r.text).toContain('characters left out');
  });
  it('applies the person\'s rules and skips a broken one', () => {
    const r = compressText('Ticket ABC-123 and ABC-456', { ...cfg, rules: [{ name: 'ids', pattern: 'ABC-\\d+', replace: '#' }, { name: 'bad', pattern: '(', replace: '' }] });
    expect(r.text).toBe('Ticket # and #');
    expect(r.saved['rule:ids']).toBeGreaterThan(0);
  });
  it('reports what each rule saved and the totals', () => {
    const r = compressText('a\n\n\n\n\nb' + '\nx'.repeat(0), cfg);
    expect(r.before).toBeGreaterThan(r.after);
  });
});

describe('what must survive', () => {
  it('Markdown quotes, SQL comments and patch headers are not mail', () => {
    expect(compressText('> **Note:** keep this\n> and this\ntext', cfg).text).toContain('keep this');
    expect(compressText('SET x;\n--\nSELECT 1;\n-- \nSELECT 2;\n-- \n'.repeat(1) + 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nm\nn\nSELECT 3;', cfg).text).toContain('SELECT 3;');
    expect(compressText('From: Bob <bob@x.io>\nSubject: fix\n\ndiff --git a/x b/x', cfg).text).toContain('diff --git');
  });
  it('tool answers get no quote / repeat filtering and the continuation note survives', () => {
    const doc = `intro\n-- \nmore\n> a\n> b\n> c\n> d\nCSV\n0,0000000\n0,0000000\n0,0000000\n\n\n\n[… 500 more characters — call read_document again with from=9000]`;
    const r = compressText(doc, cfg, 'tool').text;
    expect(r).toContain('call read_document again with from=9000');
    expect(r).toContain('> a');
    expect(r).not.toContain('(×3)');
  });
  it('code fences, indentation and alignment are left alone', () => {
    const code = 'Run:\n```py\nx    = 1\n\n\n\ny = 2\nsame line here\nsame line here\nsame line here\n```\n    indented  text   \n';
    const r = compressText(code, cfg).text;
    expect(r).toContain('x    = 1\n\n\n\ny = 2');
    expect(r).toContain('same line here\nsame line here\nsame line here');
    expect(r).toContain('    indented  text');
  });
  it('transcript lines and a problem in the middle of a log are not lost', () => {
    const tr = Array.from({ length: 80 }, (_, i) => `[${Math.floor(i / 60)}:${String(i % 60).padStart(2, '0')}] sentence ${i}`).join('\n');
    expect(compressText(tr, cfg, 'tool').text).toContain('sentence 40');
    const log = Array.from({ length: 80 }, (_, i) => `2026-01-01 10:00:00 ${i === 40 ? 'ERROR disk full' : 'INFO ok ' + i}`).join('\n');
    const r = compressText(log, { ...cfg, logKeepHead: 5, logKeepTail: 5 }).text;
    expect(r).toContain('ERROR disk full');
    expect(r).toContain('lines that report a problem are kept');
  });
  it('never returns something longer than it was given', () => {
    const t = 'x\n> a\n</passage>';
    expect(compressText(t, cfg).text.length).toBeLessThanOrEqual(t.length);
  });
  it('a pathological custom rule is refused and cannot run; the built-in rules are fast on long space runs', () => {
    const t0 = Date.now();
    const r = compressText(`${'a'.repeat(30)}!`, { ...cfg, rules: [{ name: 'evil', pattern: '(a+)+$', replace: '' }] });
    expect(r.text).toBe(`${'a'.repeat(30)}!`);
    const spaces = `${' '.repeat(100_000)}x\n`;
    compressText(spaces, cfg);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(validRulePattern('(a+)+$')).toMatch(/catastrophic/);
    expect(validRulePattern('^Confidential.*$', 'im')).toBeNull();
  });
});

describe('normalizeCompression', () => {
  it('fills in defaults and drops garbage', () => {
    expect(normalizeCompression(null)).toEqual(DEFAULT_COMPRESSION);
    const c = normalizeCompression({ enabled: false, minChars: -5, logKeepHead: 1, rules: [{ pattern: '' }, { name: 'a', pattern: 'x', flags: 'gq' }, 5] });
    expect(c.enabled).toBe(false);
    expect(c.minChars).toBe(DEFAULT_COMPRESSION.minChars);
    expect(c.logKeepHead).toBe(3);
    expect(c.rules).toEqual([{ name: 'a', pattern: 'x', replace: '', flags: 'g' }]);
  });
});
