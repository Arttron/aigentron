import { describe, expect, it } from 'vitest';
import { projectFacts } from './project-orientation';

const base = { name: 'Arttron dev', slug: 'arttron-dev', isDefault: false, kind: 'code' as const, repoUrl: 'git@github.com:acme/shop.git', repoBranch: 'main', repoSubdir: '', repoAuth: 'ssh' as const, isolation: 'worktree' as const, verifyCommands: ['npm test', 'npm run lint'], verifyMaxAttempts: 3 };
const both = { fetch: true, push: true };

describe('projectFacts', () => {
  it('names the repository, branch, access, tools, isolation and verification', () => {
    const t = projectFacts(base, both).join('\n');
    expect(t).toContain('git@github.com:acme/shop.git');
    expect(t).toContain('base branch `main`');
    expect(t).toContain('SSH deploy key');
    expect(t).toContain('You hold no credentials');
    expect(t).toContain('`fetch_remote`');
    expect(t).toContain('`push_branch`');
    expect(t).toContain('**worktree**');
    expect(t).toContain('origin/main');
    expect(t).toContain('`npm test`, `npm run lint`');
    expect(t).toContain('up to 3 attempts');
  });
  it('shared mode, a subdirectory, no verification', () => {
    const t = projectFacts({ ...base, isolation: 'shared', repoSubdir: 'web', verifyCommands: [] }, both).join('\n');
    expect(t).toContain('**shared**');
    expect(t).toContain('subdirectory `web`');
    expect(t).toContain('verification: none');
  });
  it('a token never appears: credentials in the URL are masked', () => {
    const t = projectFacts({ ...base, repoUrl: 'https://x-access-token:ghp_SECRET123@github.com/acme/shop.git', repoAuth: 'token' }, both).join('\n');
    expect(t).not.toContain('ghp_SECRET123');
    expect(t).toContain('HTTPS token');
  });
  it('no remote, or a docs project', () => {
    expect(projectFacts({ ...base, repoUrl: null }, { fetch: false, push: false }).join('\n')).toContain('local only');
    expect(projectFacts({ ...base, kind: 'docs' }, both)).toEqual([]);
  });
  it('only the tools that are wired are named', () => {
    const t = projectFacts(base, { fetch: true, push: false }).join('\n');
    expect(t).toContain('`fetch_remote`');
    expect(t).not.toContain('`push_branch`');
  });
});
