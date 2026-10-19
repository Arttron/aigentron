import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectsService, type ProjectRow } from './projects.service';
import { DEFAULT_PROJECT_ID } from './project-core';
import { projectLabel } from './project-labels';

type Row = ProjectRow;
type TaskRow = { id: string; projectId: string; status: string };

/** A fake Prisma over in-memory rows: just what ProjectsService touches. */
function fakePrisma(projects: Row[], tasks: TaskRow[], settings: Record<string, unknown> | null) {
  let n = 0;
  const now = () => new Date('2026-10-19T10:00:00Z');
  const matchWhere = (r: Row, where: Record<string, unknown>) => Object.entries(where).every(([k, v]) => (r as never as Record<string, unknown>)[k] === v);
  const prisma = {
    project: {
      findUnique: async ({ where }: { where: Partial<Row> }) => projects.find((r) => (where.id ? r.id === where.id : r.slug === where.slug)) ?? null,
      findMany: async ({ where }: { where?: Record<string, unknown> } = {}) => projects.filter((r) => (where && 'archivedAt' in where ? r.archivedAt === where.archivedAt : true)),
      create: async ({ data }: { data: Partial<Row> }) => {
        const row = { id: `p${++n}`, isDefault: false, kind: 'code', repoUrl: null, repoBranch: 'main', repoSubdir: null, repoAuth: 'none', repoPath: null, isolation: null, verifyCommands: null, verifyMaxAttempts: 2, defaultAgent: null, notifyChannelId: null, notifyChatId: null, archivedAt: null, createdById: null, createdAt: now(), updatedAt: now(), ...data } as Row;
        projects.push(row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
        const row = projects.find((r) => r.id === where.id)!;
        Object.assign(row, data, { updatedAt: now() });
        return row;
      },
      delete: async ({ where }: { where: { id: string } }) => {
        const i = projects.findIndex((r) => r.id === where.id);
        return projects.splice(i, 1)[0];
      },
    },
    task: {
      count: async ({ where }: { where: { projectId: string; status?: { in: string[] } } }) => tasks.filter((t) => t.projectId === where.projectId && (!where.status || where.status.in.includes(t.status))).length,
      updateMany: async ({ where, data }: { where: { projectId: string }; data: { projectId: string } }) => {
        const hit = tasks.filter((t) => t.projectId === where.projectId);
        for (const t of hit) t.projectId = data.projectId;
        return { count: hit.length };
      },
      groupBy: async ({ where }: { where: { projectId: { in: string[] } } }) => {
        const out = new Map<string, number>();
        for (const t of tasks.filter((t) => where.projectId.in.includes(t.projectId))) out.set(`${t.projectId}|${t.status}`, (out.get(`${t.projectId}|${t.status}`) ?? 0) + 1);
        return [...out].map(([k, c]) => ({ projectId: k.split('|')[0], status: k.split('|')[1], _count: { _all: c } }));
      },
    },
    knowledgeBase: {
      count: async ({ where }: { where: { projectId: string } }) => kbs.filter((k) => k.projectId === where.projectId).length,
      groupBy: async ({ where }: { where: { projectId: { in: string[] } } }) => {
        const out = new Map<string, number>();
        for (const k of kbs.filter((k) => k.projectId && where.projectId.in.includes(k.projectId))) out.set(k.projectId!, (out.get(k.projectId!) ?? 0) + 1);
        return [...out].map(([projectId, c]) => ({ projectId, _count: { _all: c } }));
      },
    },
    appSettings: { findUnique: async () => settings },
    _match: matchWhere,
  };
  return prisma;
}
type KbRow = { id: string; projectId: string | null };
let kbs: KbRow[] = [];
/** What the lazily resolved ResourcesService / KnowledgeService get asked for (recorded, answered with fixed numbers). */
const calls: string[] = [];
const fakeModuleRef = {
  get: (cls: { name: string }) => {
    if (cls.name === 'ResourcesService') return { countOf: async (p: { slug: string }) => (p.slug === 'shop' ? 2 : 0), releaseProject: async (p: { slug: string }, mode: string) => (calls.push(`resources:${p.slug}:${mode}`), { moved: mode === 'keep' ? 2 : 0, deleted: mode === 'keep' ? 0 : 2 }) };
    if (cls.name === 'KnowledgeService') return { releaseProject: async (id: string, mode: string) => (calls.push(`knowledge:${id}:${mode}`), { released: mode === 'keep' ? 1 : 0, deleted: mode === 'keep' ? 0 : 1 }) };
    return null;
  },
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lds-projects-'));
  kbs = [];
  calls.length = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function make(opts: { projects?: Row[]; tasks?: TaskRow[]; settings?: Record<string, unknown> | null; shared?: boolean } = {}) {
  const projects = opts.projects ?? [];
  const tasks = opts.tasks ?? [];
  const prisma = fakePrisma(projects, tasks, opts.settings ?? null);
  const config = { workspaceRepoPath: join(dir, 'repo'), workspaceDir: join(dir, 'workspace'), projectsDir: join(dir, 'projects'), secretsDir: join(dir, 'secrets'), agentDir: join(dir, 'agent'), workspaceShared: opts.shared ?? true };
  const svc = new ProjectsService(prisma as never, config as never, fakeModuleRef as never);
  return { svc, projects, tasks, config };
}

const defaultRow = (over: Partial<Row> = {}): Row => ({ id: DEFAULT_PROJECT_ID, slug: 'default', name: 'Default', kind: 'code', isDefault: true, repoUrl: null, repoBranch: 'main', repoSubdir: null, repoAuth: 'none', repoPath: '/old/path', isolation: null, verifyCommands: null, verifyMaxAttempts: 2, defaultAgent: null, notifyChannelId: null, notifyChatId: null, archivedAt: null, createdById: null, createdAt: new Date(), updatedAt: new Date(), ...over });

describe('ensureDefault', () => {
  it('creates the default project from AppSettings when the row is missing, adopting WORKSPACE_REPO_PATH', async () => {
    const { svc, projects, config } = make({ settings: { repoUrl: 'https://github.com/acme/w.git', repoBranch: 'develop', githubToken: 'ghp_x', workspaceSubdir: 'packages/api', verifyCommands: 'pnpm test', verifyMaxAttempts: 3, defaultAgent: 'pm', notifyChannelId: 'c1', notifyChatId: '42' } });
    const row = await svc.ensureDefault();
    expect(projects).toHaveLength(1);
    expect(row).toMatchObject({ id: DEFAULT_PROJECT_ID, slug: 'default', isDefault: true, kind: 'code', repoUrl: 'https://github.com/acme/w.git', repoBranch: 'develop', repoSubdir: 'packages/api', repoAuth: 'token', repoPath: config.workspaceRepoPath, verifyCommands: 'pnpm test', verifyMaxAttempts: 3, defaultAgent: 'pm', notifyChannelId: 'c1', notifyChatId: '42' });
    expect(JSON.stringify(row)).not.toContain('ghp_x');
    expect(projectLabel(DEFAULT_PROJECT_ID)).toEqual({ slug: 'default', name: 'Default' });
  });
  it('re-adopts the configured repo path on an existing row (no copying, nothing else touched)', async () => {
    const { svc, config } = make({ projects: [defaultRow({ repoPath: '/old/path', repoUrl: 'keep' })] });
    const row = await svc.ensureDefault();
    expect(row.repoPath).toBe(config.workspaceRepoPath);
    expect(row.repoUrl).toBe('keep');
    expect(existsSync(join(dir, 'repo'))).toBe(false); // adoption is a row update, not a filesystem change
  });
  it('the default project has no layout of its own (the workspace is its layout) and the bare serialized shape never carries a secret', async () => {
    const { svc, config } = make({ projects: [defaultRow()] });
    const row = await svc.ensureDefault();
    expect(await svc.ensureLayout(row)).toBe(config.workspaceDir);
    expect(existsSync(join(config.workspaceDir, 'memory'))).toBe(false);
    const json = await svc.serialize(row);
    expect(json).toEqual({
      id: DEFAULT_PROJECT_ID, slug: 'default', name: 'Default', kind: 'code', isDefault: true,
      repo: { url: null, branch: 'main', subdir: null, auth: 'none', path: config.workspaceRepoPath },
      isolation: null, effectiveIsolation: 'shared', verifyCommands: null, verifyMaxAttempts: 2, defaultAgent: null, notifyChannelId: null, notifyChatId: null,
      archivedAt: null, counts: { active: 0, total: 0, resources: 0, knowledge: 0 }, createdAt: expect.any(String), updatedAt: expect.any(String),
    });
    expect(Object.keys(json)).not.toContain('githubToken');
  });
});

describe('create', () => {
  it('derives a unique ascii slug, applies defaults, creates the folder layout and PROJECT.md', async () => {
    const { svc, config } = make({ projects: [defaultRow()] });
    const a = await svc.create({ name: 'Кухня 2' });
    expect(a).toMatchObject({ slug: 'kukhnya-2', name: 'Кухня 2', kind: 'code', repoBranch: 'main', repoAuth: 'none', verifyMaxAttempts: 2, isDefault: false });
    const b = await svc.create({ name: 'кухня 2', kind: 'docs' });
    expect(b.slug).toBe('kukhnya-2-2');
    const base = join(config.projectsDir, 'kukhnya-2');
    for (const f of ['memory', 'work', 'deliverables', 'library']) expect(existsSync(join(base, f))).toBe(true);
    expect(readFileSync(join(base, 'PROJECT.md'), 'utf8')).toContain('# Кухня 2');
    expect(existsSync(join(base, 'memory', 'decisions.md'))).toBe(true);
    expect(svc.repoPathOf(a)).toBe(join(base, 'repo'));
    expect(projectLabel(a.id)).toEqual({ slug: 'kukhnya-2', name: 'Кухня 2' });
  });
  it('takes a typed slug as is, refuses a bad / reserved / taken one', async () => {
    const { svc } = make({ projects: [defaultRow()] });
    const p = await svc.create({ name: 'Shop', slug: 'shop-be' });
    expect(p.slug).toBe('shop-be');
    await expect(svc.create({ name: 'x', slug: 'Shop' })).rejects.toThrow(/lowercase/);
    await expect(svc.create({ name: 'x', slug: 'default' })).rejects.toThrow(/reserved/);
    await expect(svc.create({ name: 'x', slug: 'shop-be' })).rejects.toThrow(/already exists/);
    await expect(svc.create({ name: '  ' })).rejects.toThrow(/name/);
  });
  it('checks the repository fields and never stores a token from the URL', async () => {
    const { svc } = make({ projects: [defaultRow()] });
    const ssh = await svc.create({ name: 'A', repoUrl: 'git@github.com:acme/a.git', repoBranch: ' develop ', repoSubdir: '/packages/api/' });
    expect(ssh).toMatchObject({ repoUrl: 'git@github.com:acme/a.git', repoAuth: 'ssh', repoBranch: 'develop', repoSubdir: 'packages/api' });
    const https = await svc.create({ name: 'B', repoUrl: 'https://github.com/acme/b', repoAuth: 'token' });
    expect(https).toMatchObject({ repoAuth: 'token' });
    await expect(svc.create({ name: 'C', repoUrl: 'https://x:ghp_1@github.com/acme/c' })).rejects.toThrow(/token/);
    await expect(svc.create({ name: 'C', repoUrl: 'not a url' })).rejects.toThrow(/repoUrl/);
    await expect(svc.create({ name: 'C', repoBranch: 'a..b' })).rejects.toThrow(/branch/);
    await expect(svc.create({ name: 'C', repoSubdir: '../x' })).rejects.toThrow(/repoSubdir/);
    await expect(svc.create({ name: 'C', repoAuth: 'magic' })).rejects.toThrow(/repoAuth/);
    await expect(svc.create({ name: 'C', isolation: 'solo' })).rejects.toThrow(/isolation/);
    await expect(svc.create({ name: 'C', verifyMaxAttempts: 11 })).rejects.toThrow(/verifyMaxAttempts/);
    await expect(svc.create({ name: 'C', repoPath: 'relative/path' })).rejects.toThrow(/absolute/);
    await expect(svc.create({ name: 'C', repoPath: join(dir, 'secrets', 'x') })).rejects.toThrow(/must not be inside/);
    const adopted = await svc.create({ name: 'D', repoPath: join(dir, 'elsewhere') });
    expect(svc.repoPathOf(adopted)).toBe(join(dir, 'elsewhere'));
  });
});

describe('update / archive / remove', () => {
  it('patches only the given fields; the slug and the default project\'s path and kind are fixed', async () => {
    const { svc, config } = make({ projects: [defaultRow()] });
    await svc.ensureDefault();
    const p = await svc.create({ name: 'Shop', repoUrl: 'https://github.com/a/b' });
    const u = await svc.update('shop', { name: 'Shop v2', verifyCommands: 'pnpm test\r\n', isolation: 'worktree' });
    expect(u).toMatchObject({ slug: 'shop', name: 'Shop v2', repoUrl: 'https://github.com/a/b', verifyCommands: 'pnpm test', isolation: 'worktree' });
    expect(projectLabel(p.id).name).toBe('Shop v2');
    await expect(svc.update('shop', { slug: 'shop2' })).rejects.toThrow(/cannot be changed/);
    await expect(svc.update('default', { kind: 'docs' })).rejects.toThrow(/default project/);
    await expect(svc.update('default', { repoPath: '/elsewhere' })).rejects.toThrow(/WORKSPACE_REPO_PATH/);
    expect((await svc.update('default', { name: 'Inbox' })).name).toBe('Inbox');
    expect((await svc.serialize(await svc.get('default'))).repo.path).toBe(config.workspaceRepoPath);
    await expect(svc.get('nope')).rejects.toThrow(/not found/);
  });
  it('archive: not the default; an archived project takes no new tasks; unarchive brings it back', async () => {
    const { svc } = make({ projects: [defaultRow()] });
    await svc.create({ name: 'Old' });
    await expect(svc.archive('default')).rejects.toThrow(/cannot be archived/);
    expect((await svc.archive('old')).archivedAt).toBeInstanceOf(Date);
    await expect(svc.forNewTask('old')).rejects.toThrow(/archived/);
    expect((await svc.list()).map((r) => r.slug)).toEqual(['default']);
    expect((await svc.list({ includeArchived: true })).map((r) => r.slug)).toEqual(['default', 'old']);
    expect((await svc.unarchive('old')).archivedAt).toBeNull();
    expect((await svc.forNewTask('old')).slug).toBe('old');
    expect((await svc.forNewTask(undefined)).slug).toBe('default');
  });
  it('remove: refused for the default and while tasks are active; finished tasks move to the default project; the library and bases are kept by default', async () => {
    const tasks: TaskRow[] = [];
    const { svc, projects } = make({ projects: [defaultRow()], tasks });
    const p = await svc.create({ name: 'Gone' });
    kbs.push({ id: 'kb1', projectId: p.id });
    tasks.push({ id: 't1', projectId: p.id, status: 'running' }, { id: 't2', projectId: p.id, status: 'done' });
    await expect(svc.remove('default')).rejects.toThrow(/cannot be deleted/);
    await expect(svc.remove('gone')).rejects.toThrow(/1 active task/);
    expect(calls).toEqual([]); // nothing was touched by the refused delete
    expect(await svc.counts(p)).toEqual({ active: 1, total: 2, resources: 0, knowledge: 1 });
    tasks[0]!.status = 'cancelled';
    await expect(svc.remove('gone', { knowledge: 'maybe' as never })).rejects.toThrow(/keep.*delete/);
    const r = await svc.remove('gone');
    expect(r).toEqual({ id: p.id, slug: 'gone', movedTasks: 2, knowledge: { released: 1, deleted: 0 }, resources: { moved: 2, deleted: 0 } });
    expect(calls).toEqual([`resources:gone:keep`, `knowledge:${p.id}:keep`]);
    expect(tasks.every((t) => t.projectId === DEFAULT_PROJECT_ID)).toBe(true);
    expect(projects.map((x) => x.slug)).toEqual(['default']);
    expect(projectLabel(p.id).slug).toBe('unknown');
  });
  it('remove with {knowledge: delete, resources: delete} hands both over for deletion', async () => {
    const { svc } = make({ projects: [defaultRow()] });
    const p = await svc.create({ name: 'Gone' });
    const r = await svc.remove('gone', { knowledge: 'delete', resources: 'delete' });
    expect(r).toMatchObject({ knowledge: { released: 0, deleted: 1 }, resources: { moved: 0, deleted: 2 } });
    expect(calls).toEqual([`resources:gone:delete`, `knowledge:${p.id}:delete`]);
  });
  it('serializeAll counts active and total tasks per project in one query, plus the project\'s own resources and knowledge bases', async () => {
    const tasks: TaskRow[] = [{ id: 'a', projectId: DEFAULT_PROJECT_ID, status: 'queued' }, { id: 'b', projectId: DEFAULT_PROJECT_ID, status: 'done' }];
    const { svc } = make({ projects: [defaultRow()], tasks, shared: false });
    const p = await svc.create({ name: 'Two' });
    const shop = await svc.create({ name: 'Shop' });
    kbs.push({ id: 'k1', projectId: shop.id }, { id: 'k2', projectId: shop.id }, { id: 'k3', projectId: null });
    tasks.push({ id: 'c', projectId: p.id, status: 'needs_approval' });
    const all = await svc.serializeAll(await svc.list());
    expect(all.map((x) => [x.slug, x.counts, x.effectiveIsolation]).sort()).toEqual([
      ['default', { active: 1, total: 2, resources: 0, knowledge: 0 }, 'worktree'],
      ['shop', { active: 0, total: 0, resources: 2, knowledge: 2 }, 'worktree'],
      ['two', { active: 1, total: 1, resources: 0, knowledge: 0 }, 'worktree'],
    ]);
    expect((await svc.serialize(shop)).counts).toEqual({ active: 0, total: 0, resources: 2, knowledge: 2 });
  });
  it('resolve: by slug, by task row, or the default', async () => {
    const { svc } = make({ projects: [defaultRow()] });
    const p = await svc.create({ name: 'R' });
    expect((await svc.resolve('r')).id).toBe(p.id);
    expect((await svc.resolve({ projectId: p.id })).slug).toBe('r');
    expect((await svc.resolve(null)).isDefault).toBe(true);
  });
});

describe('contextFor / defaultAgentFor / notifyTargetFor (the runtime view)', () => {
  it('the default project context reads the installation paths; a project its own folder, repo, verify and fallbacks', async () => {
    const { svc, config } = make({ projects: [defaultRow({ verifyCommands: 'pnpm test', repoSubdir: 'apps/api' })], settings: { defaultAgent: 'pm', notifyChannelId: 'c1', notifyChatId: '42' } });
    const def = await svc.contextFor(null);
    expect(def).toMatchObject({ slug: 'default', isDefault: true, repoPath: config.workspaceRepoPath, workspaceRoot: config.workspaceDir, briefFile: 'WORKSPACE.md', repoSubdir: 'apps/api', verifyCommands: ['pnpm test'], isolation: 'shared', defaultAgent: 'pm', notifyChannelId: 'c1', notifyChatId: '42' });
    const p = await svc.create({ name: 'Shop', repoUrl: 'https://github.com/a/b', repoAuth: 'token', isolation: 'worktree', verifyCommands: 'pnpm lint', defaultAgent: 'dev', notifyChannelId: 'c2' });
    const shop = await svc.contextFor({ projectId: p.id });
    expect(shop).toMatchObject({ slug: 'shop', repoPath: join(config.projectsDir, 'shop', 'repo'), workspaceRoot: join(config.projectsDir, 'shop'), briefFile: 'PROJECT.md', repoUrl: 'https://github.com/a/b', isolation: 'worktree', verifyCommands: ['pnpm lint'], defaultAgent: 'dev', notifyChannelId: 'c2', notifyChatId: '42', git: { slug: 'shop', repoUrl: 'https://github.com/a/b', repoAuth: 'token' } });
    expect((await svc.contextFor('shop')).id).toBe(p.id);
    expect((await svc.contextFor(p)).id).toBe(p.id);
    expect(await svc.defaultAgentFor(p)).toBe('dev');
    expect(await svc.defaultAgentFor({ defaultAgent: null })).toBe('pm');
  });
  it('notifyTargetFor: the task\'s project chat, else the global one, else null', async () => {
    const tasks: TaskRow[] = [];
    const { svc, prisma } = (() => {
      const r = make({ projects: [defaultRow()], tasks, settings: { notifyChannelId: 'c1', notifyChatId: '42' } });
      return { svc: r.svc, prisma: (r.svc as unknown as { prisma: Record<string, Record<string, unknown>> }).prisma };
    })();
    const p = await svc.create({ name: 'Own', notifyChannelId: 'c9', notifyChatId: '7' });
    const q = await svc.create({ name: 'Half', notifyChannelId: 'c9' });
    tasks.push({ id: 't1', projectId: p.id, status: 'queued' }, { id: 't2', projectId: DEFAULT_PROJECT_ID, status: 'queued' }, { id: 't3', projectId: q.id, status: 'queued' });
    prisma.task.findUnique = async ({ where }: { where: { id: string } }) => tasks.find((t) => t.id === where.id) ?? null;
    expect(await svc.notifyTargetFor('t1')).toEqual({ channelId: 'c9', chatId: '7' });
    expect(await svc.notifyTargetFor('t2')).toEqual({ channelId: 'c1', chatId: '42' });
    expect(await svc.notifyTargetFor('t3')).toEqual({ channelId: 'c9', chatId: '42' }); // field by field, like the global fallback
    expect(await svc.notifyTargetFor('nope')).toEqual({ channelId: 'c1', chatId: '42' }); // an unknown task → the default project's target
  });
});
