import { describe, expect, it } from 'vitest';
import { TasksService, serializeTask } from './tasks.service';
import { DEFAULT_PROJECT_ID } from '../projects/project-core';
import { setProjectLabels } from '../projects/project-labels';

/** A task is created in a project: the given slug, its parent's, or the default; the wire shape names it. */
type Row = { id: string; projectId: string; parentId: string | null; status: string; [k: string]: unknown };
type Proj = { id: string; slug: string; name: string; archivedAt: Date | null; isDefault: boolean };

function make(projects: Proj[]) {
  const rows: Row[] = [];
  const prisma = {
    task: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `t${rows.length + 1}`, createdAt: new Date(), updatedAt: new Date(), branch: null, worktreePath: null, prUrl: null, pushedTo: null, error: null, createdById: null, ...data } as Row;
        rows.push(row);
        return row;
      },
      findUnique: async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id) ?? null,
      findMany: async () => [],
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => Object.assign(rows.find((r) => r.id === where.id)!, data),
    },
  };
  const projectsSvc = {
    getDefault: async () => projects.find((p) => p.isDefault)!,
    getById: async (id: string) => {
      const p = projects.find((x) => x.id === id);
      if (!p) throw new Error(`Project ${id} not found`);
      return p;
    },
    defaultAgentFor: async () => null,
    get: async (slug: string) => {
      const p = projects.find((x) => x.slug === slug);
      if (!p) throw new Error(`Project "${slug}" not found`);
      return p;
    },
    forNewTask: async (slug?: string) => {
      if (!slug) return projects.find((p) => p.isDefault)!;
      const p = projects.find((x) => x.slug === slug);
      if (!p) throw new Error(`Project "${slug}" not found`);
      if (p.archivedAt) throw new Error(`Project "${slug}" is archived`);
      return p;
    },
  };
  const svc = Object.create(TasksService.prototype) as TasksService & Record<string, unknown>;
  Object.assign(svc, {
    prisma,
    projects: projectsSvc,
    logger: { log: () => undefined, warn: () => undefined },
    queue: { enqueue: async () => undefined },
    bus: { publish: () => undefined },
    agents: { get: async () => null, list: async () => [] },
    settings: { defaultAgent: async () => null },
    get: async (id: string) => {
      const r = rows.find((x) => x.id === id);
      if (!r) throw new Error('not found');
      return { ...r, linksOut: [] };
    },
    nameSoon: () => undefined,
    linkReferences: async () => undefined,
  });
  setProjectLabels(projects);
  return { svc: svc as unknown as TasksService, rows };
}

const DEFAULT: Proj = { id: DEFAULT_PROJECT_ID, slug: 'default', name: 'Default', archivedAt: null, isDefault: true };
const SHOP: Proj = { id: 'p_shop', slug: 'shop', name: 'Shop', archivedAt: null, isDefault: false };
const OLD: Proj = { id: 'p_old', slug: 'old', name: 'Old', archivedAt: new Date(), isDefault: false };

describe('TasksService.create and projects', () => {
  it('goes into the default project when none is given — exactly as before projects', async () => {
    const { svc } = make([DEFAULT, SHOP]);
    const t = await svc.create({ prompt: 'do it' });
    expect(t.projectId).toBe(DEFAULT_PROJECT_ID);
    expect(serializeTask(t as never)).toMatchObject({ projectId: DEFAULT_PROJECT_ID, project: { slug: 'default', name: 'Default' } });
  });
  it('goes into the named project; an unknown or archived one is refused', async () => {
    const { svc } = make([DEFAULT, SHOP, OLD]);
    const t = await svc.create({ prompt: 'do it', project: 'shop' });
    expect(serializeTask(t as never).project).toEqual({ slug: 'shop', name: 'Shop' });
    await expect(svc.create({ prompt: 'x', project: 'old' })).rejects.toThrow(/archived/);
    await expect(svc.create({ prompt: 'x', project: 'nope' })).rejects.toThrow(/not found/);
  });
  it('a subtask is in its parent\'s project, whatever slug was passed', async () => {
    const { svc } = make([DEFAULT, SHOP]);
    const parent = await svc.create({ prompt: 'lead', project: 'shop' });
    const child = await svc.createSubtask(parent.id, { prompt: 'part' });
    expect(child.projectId).toBe('p_shop');
    const forced = await svc.create({ prompt: 'part 2', parentId: parent.id, project: 'default' });
    expect(forced.projectId).toBe('p_shop');
  });
  it('the serialized task prefers a loaded relation over the label cache, and names an unknown id honestly', () => {
    const base = { id: 't', prompt: 'p', title: 't', status: 'queued', branch: null, worktreePath: null, agentName: null, prUrl: null, pushedTo: null, error: null, createdById: null, parentId: null, createdAt: new Date(), updatedAt: new Date() };
    setProjectLabels([DEFAULT]);
    expect(serializeTask({ ...base, projectId: 'p_x', project: { slug: 'x', name: 'X' } } as never).project).toEqual({ slug: 'x', name: 'X' });
    expect(serializeTask({ ...base, projectId: 'p_x' } as never).project).toEqual({ slug: 'unknown', name: 'Unknown project' });
    expect(serializeTask({ ...base, projectId: DEFAULT_PROJECT_ID } as never).project).toEqual({ slug: 'default', name: 'Default' });
  });
});
