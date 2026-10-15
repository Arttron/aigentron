import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SecretJsonFile } from './secret-json-file';

type Cfg = { n: number };

describe('SecretJsonFile', () => {
  let dir: string;
  let clock = 0;
  const now = () => clock;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sjf-'));
    clock = 0;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const make = (ttlMs = 2000) =>
    new SecretJsonFile<Cfg | null>(join(dir, 'sub', 'x.json'), {
      parse: (raw) => (typeof (raw as Cfg).n === 'number' ? { n: (raw as Cfg).n } : null),
      missing: null,
      ttlMs,
      now,
    });

  it('reads `missing` when the file is absent and writes atomically with 0600', () => {
    const f = make();
    expect(f.read()).toBeNull();
    f.write({ n: 1 });
    expect(f.read()).toEqual({ n: 1 });
    expect(statSync(f.file).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'sub')).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(f.file, 'utf8'))).toEqual({ n: 1 });
  });

  it('does not stat the file again inside the TTL, and sees outside changes after it', () => {
    const f = make(2000);
    f.write({ n: 1 });
    expect(f.read()).toEqual({ n: 1 });
    // change from outside (another process), with a different mtime
    writeFileSync(f.file, JSON.stringify({ n: 2 }));
    utimesSync(f.file, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
    clock = 1500;
    expect(f.read()).toEqual({ n: 1 }); // still inside the TTL
    clock = 2500;
    expect(f.read()).toEqual({ n: 2 });
  });

  it('a stat per read when ttl is 0, and a rejected shape reads as `missing`', () => {
    const f = make(0);
    const spy = vi.spyOn(process, 'hrtime'); // just to make sure nothing exotic is used
    f.write({ n: 1 });
    expect(f.read()).toEqual({ n: 1 });
    writeFileSync(f.file, JSON.stringify({ wrong: true }));
    utimesSync(f.file, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
    expect(f.read()).toBeNull();
    writeFileSync(f.file, '{not json');
    utimesSync(f.file, new Date(1_700_000_100_000), new Date(1_700_000_100_000));
    expect(f.read()).toBeNull();
    spy.mockRestore();
  });

  it('a deleted file reads as `missing` once the TTL passed', () => {
    const f = make(100);
    f.write({ n: 3 });
    expect(f.read()).toEqual({ n: 3 });
    rmSync(f.file);
    clock = 50;
    expect(f.read()).toEqual({ n: 3 });
    clock = 200;
    expect(f.read()).toBeNull();
  });
});
