import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildProjectContext, docsWorkDirOf, extraWriteRootsFor, parseVerifyCommands, resolveWorkDir, slugifyTitle, taskBranchFor, worktreePathFor, type ProjectContextRow } from './project-context';
import { DEFAULT_PROJECT_ID } from './project-core';

const paths = { workspaceRepoPath: '/data/repo', workspaceDir: '/data/workspace', projectsDir: '/data/projects', workspaceShared: true };

const row = (over: Partial<ProjectContextRow> = {}): ProjectContextRow => ({
  id: 'p1',
  slug: 'shop',
  name: 'Shop',
  kind: 'code',
  isDefault: false,
  repoUrl: 'https://github.com/acme/shop.git',
  repoBranch: 'develop',
  repoSubdir: '/packages/api/',
  repoAuth: 'token',
  repoPath: null,
  isolation: null,
  verifyCommands: 'pnpm lint\n\n pnpm test \n',
  verifyMaxAttempts: 3,
  defaultAgent: null,
  notifyChannelId: null,
  notifyChatId: null,
  ...over,
});

const defaultRow = (over: Partial<ProjectContextRow> = {}): ProjectContextRow =>
  row({ id: DEFAULT_PROJECT_ID, slug: 'default', name: 'Default', isDefault: true, repoPath: '/data/repo', repoUrl: null, repoBranch: 'main', repoSubdir: null, repoAuth: 'none', verifyCommands: null, verifyMaxAttempts: 2, ...over });

describe('buildProjectContext', () => {
  it('the default project resolves to exactly the installation\'s paths and settings of today', () => {
    const c = buildProjectContext(defaultRow(), paths, { defaultAgent: 'pm', notifyChannelId: 'c1', notifyChatId: '42' });
    expect(c).toMatchObject({
      slug: 'default',
      isDefault: true,
      repoPath: '/data/repo',
      repoUrl: null,
      repoBranch: 'main',
      repoSubdir: '',
      isolation: 'shared',
      verifyCommands: [],
      verifyMaxAttempts: 2,
      workspaceRoot: '/data/workspace',
      briefFile: 'WORKSPACE.md',
      defaultAgent: 'pm',
      notifyChannelId: 'c1',
      notifyChatId: '42',
      git: { slug: 'default', repoUrl: null, repoAuth: 'none' },
    });
    // WORKSPACE_SHARED=false → worktree mode, as before
    expect(buildProjectContext(defaultRow(), { ...paths, workspaceShared: false }).isolation).toBe('worktree');
    // the environment decides the default project's checkout, whatever the row says (it is re-adopted at boot)
    expect(buildProjectContext(defaultRow({ repoPath: null }), paths).repoPath).toBe('/data/repo');
    expect(buildProjectContext(defaultRow({ repoPath: '/old/path' }), paths).repoPath).toBe('/data/repo');
  });

  it('another project lives under PROJECTS_DIR with its checkout in repo/ and its own settings', () => {
    const c = buildProjectContext(row(), paths, { defaultAgent: 'pm', notifyChannelId: 'c1', notifyChatId: '42' });
    expect(c).toMatchObject({
      slug: 'shop',
      kind: 'code',
      repoPath: '/data/projects/shop/repo',
      repoUrl: 'https://github.com/acme/shop.git',
      repoBranch: 'develop',
      repoSubdir: 'packages/api',
      repoAuth: 'token',
      isolation: 'shared',
      verifyCommands: ['pnpm lint', 'pnpm test'],
      verifyMaxAttempts: 3,
      workspaceRoot: '/data/projects/shop',
      briefFile: 'PROJECT.md',
      git: { slug: 'shop', repoUrl: 'https://github.com/acme/shop.git', repoAuth: 'token' },
    });
    expect(c.briefTemplate).toContain('# Shop');
    // its own isolation / agent / chat win over the installation's; the global ones are the fallback
    const own = buildProjectContext(row({ isolation: 'worktree', defaultAgent: 'dev', notifyChannelId: 'c9', notifyChatId: '7' }), paths, { defaultAgent: 'pm', notifyChannelId: 'c1', notifyChatId: '42' });
    expect(own).toMatchObject({ isolation: 'worktree', defaultAgent: 'dev', notifyChannelId: 'c9', notifyChatId: '7' });
    expect(buildProjectContext(row(), paths, { defaultAgent: 'pm' })).toMatchObject({ defaultAgent: 'pm', notifyChannelId: null, notifyChatId: null });
    // an adopted checkout elsewhere
    expect(buildProjectContext(row({ repoPath: '/srv/shop' }), paths).repoPath).toBe('/srv/shop');
  });

  it('a docs project has no verify commands and works in work/', () => {
    const c = buildProjectContext(row({ kind: 'docs' }), paths);
    expect(c.kind).toBe('docs');
    expect(c.verifyCommands).toEqual([]);
    expect(docsWorkDirOf(c)).toBe('/data/projects/shop/work');
  });

  it('tolerates junk in the row (unknown kind / auth, negative attempts)', () => {
    const c = buildProjectContext(row({ kind: 'weird', repoAuth: 'magic', verifyMaxAttempts: -1, repoBranch: ' ' }), paths);
    expect(c).toMatchObject({ kind: 'code', repoAuth: 'none', verifyMaxAttempts: 0, repoBranch: 'main' });
  });
});

describe('paths and roots', () => {
  it('worktrees nest per project; the branch names the task', () => {
    expect(worktreePathFor('/data/worktrees', 'shop', 't1')).toBe('/data/worktrees/shop/t1');
    expect(taskBranchFor('t1')).toBe('agent/task-t1');
    expect(taskBranchFor('cmvow6fbs006ks5p85b6yvhs1', 'Fix the login button!')).toBe('agent/fix-login-button-6yvhs1');
    expect(taskBranchFor('t1', '???')).toBe('agent/task-t1');
  });

  it('extra write roots: the project folder, plus the checkout in shared mode; never the task root itself', () => {
    const shared = buildProjectContext(row(), paths);
    expect(extraWriteRootsFor(shared, '/data/projects/shop/repo')).toEqual(['/data/projects/shop']);
    const wt = buildProjectContext(row({ isolation: 'worktree' }), paths);
    expect(extraWriteRootsFor(wt, '/data/worktrees/shop/t1')).toEqual(['/data/projects/shop']);
    // the default project in shared mode: exactly the shared workspace, as before (the repo IS the task root)
    const def = buildProjectContext(defaultRow(), paths);
    expect(extraWriteRootsFor(def, '/data/repo')).toEqual(['/data/workspace']);
    // a docs project: its folder only
    expect(extraWriteRootsFor(buildProjectContext(row({ kind: 'docs' }), paths), '/data/projects/shop/work')).toEqual(['/data/projects/shop']);
  });

  it('parseVerifyCommands drops blanks and trims', () => {
    expect(parseVerifyCommands(' a \n\n b\r\n')).toEqual(['a', 'b']);
    expect(parseVerifyCommands(null)).toEqual([]);
  });
});

describe('resolveWorkDir', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wd-'));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('uses the subdirectory when it exists, the root otherwise (with a warning)', async () => {
    await mkdir(join(dir, 'packages', 'api'), { recursive: true });
    await writeFile(join(dir, 'file.txt'), 'x');
    const warnings: string[] = [];
    expect(await resolveWorkDir(dir, 'packages/api', (m) => warnings.push(m))).toBe(join(dir, 'packages', 'api'));
    expect(await resolveWorkDir(dir, '', (m) => warnings.push(m))).toBe(dir);
    expect(warnings).toEqual([]);
    expect(await resolveWorkDir(dir, 'missing', (m) => warnings.push(m))).toBe(dir);
    expect(await resolveWorkDir(dir, 'file.txt', (m) => warnings.push(m))).toBe(dir);
    expect(warnings).toHaveLength(2);
  });
});

describe('slugifyTitle', () => {
  it('readable ascii slugs, Cyrillic transliterated, long titles cut at a word', () => {
    expect(slugifyTitle('Fix the login button!')).toBe('fix-login-button');
    expect(slugifyTitle('Починить кнопку входа')).toBe('pochinit-knopku-vhoda');
    expect(slugifyTitle('  ---  ')).toBe('');
    expect(slugifyTitle('Refactor the whole authentication module and the session storage layer')).toBe('refactor-whole');
    expect(slugifyTitle('Supercalifragilisticexpialidocious_thing')).toBe('supercalifragilisticexpialid');
    expect(slugifyTitle('Add OAuth login via Google')).toBe('add-oauth-login-via');
  });
});
