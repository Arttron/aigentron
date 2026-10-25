import { describe, expect, it } from 'vitest';
import { PROJECT_UID_BASE, PROJECT_UID_LAST, allocateProjectUid, projectIsolationSupport, projectUidCapacity, systemIdsInRange, type IsolationFacts } from './project-isolation';

const ok: IsolationFacts = { platform: 'linux', isRoot: true, hasSetpriv: true, baseOn: true, baseBroken: null, rangeTakenBySystem: 0, probe: { ok: true, detail: 'private' } };

describe('project uids', () => {
  it('starts at the base and takes the next free one', () => {
    expect(allocateProjectUid([])).toBe(PROJECT_UID_BASE);
    expect(allocateProjectUid([40000, 40001])).toBe(40002);
    expect(allocateProjectUid([40001])).toBe(40000); // a freed number is reused
  });
  it('skips what the system already uses', () => {
    expect(allocateProjectUid([40000], [40001, 40002])).toBe(40003);
  });
  it('null when the range is full', () => {
    const all = Array.from({ length: projectUidCapacity() }, (_, i) => PROJECT_UID_BASE + i);
    expect(all.at(-1)).toBe(PROJECT_UID_LAST);
    expect(allocateProjectUid(all)).toBeNull();
  });
  it('finds the system ids inside the range in passwd and group', () => {
    const passwd = 'root:x:0:0::/root:/bin/sh\nsvc:x:40005:40005::/home/svc:/bin/false\nweb:x:33:33::/var/www:/usr/sbin/nologin\nbad line\n';
    const group = 'root:x:0:\nsvc:x:40005:\nother:x:40100:\ntoo:x:50001:\n';
    expect(systemIdsInRange(passwd, group)).toEqual([40005, 40100]);
    expect(systemIdsInRange('', '')).toEqual([]);
  });
});

describe('projectIsolationSupport', () => {
  it('a Linux root server with the base isolation and a passing probe is supported', () => {
    expect(projectIsolationSupport(ok)).toEqual({ supported: true, reason: null });
  });
  it.each([
    ['not linux', { platform: 'darwin' }, /Linux/],
    ['not root', { isRoot: false }, /not running as root/],
    ['no setpriv', { hasSetpriv: false }, /setpriv/],
    ['no base isolation', { baseOn: false }, /aigentron harden/],
    ['base isolation broken', { baseBroken: 'secrets readable' }, /not working: secrets readable/],
    ['probe did not run', { probe: null }, /could not run/],
    ['probe failed', { probe: { ok: false, detail: 'chown has no effect' } }, /does not keep one user's folder private.*chown has no effect/],
  ])('%s → not supported, with the reason in words', (_n, over, re) => {
    const r = projectIsolationSupport({ ...ok, ...over } as IsolationFacts);
    expect(r.supported).toBe(false);
    expect(r.reason).toMatch(re);
  });
  it('the first missing thing is the one named', () => {
    expect(projectIsolationSupport({ ...ok, platform: 'win32', isRoot: false }).reason).toMatch(/Linux/);
  });
});
