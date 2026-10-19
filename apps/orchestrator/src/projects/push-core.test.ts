import { describe, expect, it } from 'vitest';
import { isSafeBranchName, parsePushRefs } from './push-core';

describe('isSafeBranchName', () => {
  it('accepts ordinary branch names', () => {
    for (const n of ['develop', 'main', 'feature/scaffold-monorepo', 'agent/task-cmvfk6ph80008', 'release-1.2', 'a_b']) expect(isSafeBranchName(n)).toBe(true);
  });
  it('refuses options, odd refs and traversal', () => {
    for (const n of ['', '-f', '--force', 'HEAD', 'refs/heads/x', '/x', 'x/', 'a..b', 'a//b', 'a/.b', 'x.lock', 'x.', 'a b', 'a;rm', 'a\nb', 'x@{1}', 'ü']) expect(isSafeBranchName(n)).toBe(false);
  });
});

describe('parsePushRefs', () => {
  it('the remote branch defaults to the local name', () => {
    expect(parsePushRefs('develop', undefined)).toEqual({ ok: true, branch: 'develop', to: 'develop' });
    expect(parsePushRefs(' develop ', ' main ')).toEqual({ ok: true, branch: 'develop', to: 'main' });
  });
  it('refuses a missing or unsafe name on either side', () => {
    expect(parsePushRefs('', 'x')).toMatchObject({ ok: false });
    expect(parsePushRefs('develop', '--delete')).toMatchObject({ ok: false });
    expect(parsePushRefs('refs/heads/x', 'x')).toMatchObject({ ok: false });
  });
});
