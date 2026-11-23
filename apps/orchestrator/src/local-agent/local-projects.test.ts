import { describe, expect, it } from 'vitest';
import { cloneableProjects } from './local-projects';

const row = (repoUrl: string | null, extra = {}) => ({ id: 'p1', slug: 'shop', name: 'Shop', repoUrl, ...extra });

describe('cloneableProjects', () => {
  it('offers https / ssh / git addresses, without credentials', () => {
    const out = cloneableProjects([
      row('https://user:ghp_SECRET@github.com/acme/shop.git', { repoBranch: 'main' }),
      row('git@github.com:acme/api.git', { id: 'p2' }),
      row('ssh://git@example.com/acme/web.git', { id: 'p3' }),
    ]);
    expect(out.map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);
    expect(JSON.stringify(out)).not.toContain('ghp_SECRET');
    expect(out[0]).toMatchObject({ branch: 'main' });
  });
  it('never offers a local path, file:, ext:: or an option-looking address', () => {
    const bad = ['/home/me/shop', 'file:///srv/git/shop.git', 'ext::sh -c touch% /tmp/x', '--upload-pack=touch /tmp/x', 'ftp://x/y', '', null];
    expect(cloneableProjects(bad.map((u) => row(u)))).toEqual([]);
  });
});
