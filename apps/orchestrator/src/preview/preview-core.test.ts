import { describe, expect, it } from 'vitest';
import { descendsFrom, parseLsofPids, parsePsTable, parseSsPids, portOwner } from './preview-core';

const table = parsePsTable(`  1     0\n 100     1\n 101   100\n 102   101\n 500     1\n 501   500\n`);

describe('preview safety helpers', () => {
  it('reads the listener pids from lsof and ss', () => {
    expect(parseLsofPids('p501\nf19\np501\np777\n')).toEqual([501, 777]);
    expect(parseLsofPids('')).toEqual([]);
    expect(parseSsPids('LISTEN 0 511 *:3200 *:* users:(("node",pid=102,fd=19),("node",pid=103,fd=20))')).toEqual([102, 103]);
  });
  it('a grandchild belongs to the shell that was started, another tree does not', () => {
    expect(descendsFrom(102, 100, table)).toBe(true);
    expect(descendsFrom(100, 100, table)).toBe(true);
    expect(descendsFrom(501, 100, table)).toBe(false);
    expect(descendsFrom(999, 100, table)).toBe(false);
  });
  it('ours, foreign (an old server of another project), or not provable', () => {
    expect(portOwner([102], 100, table)).toEqual({ kind: 'ours' });
    expect(portOwner([501], 100, table)).toEqual({ kind: 'foreign', pids: [501] });
    expect(portOwner([], 100, table)).toEqual({ kind: 'unknown' });
    expect(portOwner(null, 100, table)).toEqual({ kind: 'unknown' });
  });
});
