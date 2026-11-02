import { describe, expect, it } from 'vitest';
import { DEFAULT_COMPRESSION } from '@lds/shared';
import { RunCompressor } from './run-compressor';

const long = `${'noise   line\n\n\n\n'.repeat(80)}end`;

describe('RunCompressor', () => {
  it('compresses messages and tool results and counts what was saved', () => {
    const c = new RunCompressor(DEFAULT_COMPRESSION);
    expect(c.message(long).length).toBeLessThan(long.length);
    c.tool('kb_read', long);
    const s = c.snapshot();
    expect(s.before).toBe(long.length * 2);
    expect(s.after).toBeLessThan(s.before);
    expect(s.saved.whitespace).toBeGreaterThan(0);
    expect(JSON.parse(c.columns().compressionSaved!)).toEqual(s.saved);
  });
  it('does nothing when switched off or for the other side', () => {
    expect(new RunCompressor({ ...DEFAULT_COMPRESSION, enabled: false }).message(long)).toBe(long);
    const c = new RunCompressor({ ...DEFAULT_COMPRESSION, applyToMessages: false });
    expect(c.message(long)).toBe(long);
    expect(c.tool('x', long).length).toBeLessThan(long.length);
    expect(new RunCompressor(DEFAULT_COMPRESSION).columns()).toEqual({});
  });
});
