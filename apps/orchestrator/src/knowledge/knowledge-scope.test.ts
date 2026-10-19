import { describe, expect, it } from 'vitest';
import { visibleBases } from './knowledge.service';

/**
 * The visibility rule for knowledge bases as a table (docs/plan-projects-workspace.md §2.7): a task sees the global bases and
 * those of ITS project, never another project's; the per-agent `agents` filter stays on top. Scope = the task's project id.
 */
const base = (name: string, projectId: string | null, agents: string[] = []) => ({ id: `id-${name}`, name, agents, projectId });
const rows = [
  base('global-open', null),
  base('global-pm', null, ['pm']),
  base('a-open', 'A'),
  base('a-pm', 'A', ['pm']),
  base('b-open', 'B'),
  base('default-open', 'proj_default'),
  base('archived-open', 'ARCH'), // an archived project is still a project: its own tasks see its bases, others do not
];
const names = (out: { name: string }[]) => out.map((b) => b.name);

describe('visibleBases', () => {
  it.each([
    ['a task of project A, any agent (pm)', { agent: 'pm', scope: { projectId: 'A' } }, ['global-open', 'global-pm', 'a-open', 'a-pm']],
    ['a task of project A, agent dev', { agent: 'dev', scope: { projectId: 'A' } }, ['global-open', 'a-open']],
    ['a task of project A, agent unknown', { agent: null, scope: { projectId: 'A' } }, ['global-open', 'a-open']],
    ['a task of project B', { agent: 'pm', scope: { projectId: 'B' } }, ['global-open', 'global-pm', 'b-open']],
    ['a task of the default project', { agent: 'pm', scope: { projectId: 'proj_default' } }, ['global-open', 'global-pm', 'default-open']],
    ['a task of the archived project', { agent: 'pm', scope: { projectId: 'ARCH' } }, ['global-open', 'global-pm', 'archived-open']],
    ['a task of a project with no bases of its own', { agent: 'pm', scope: { projectId: 'C' } }, ['global-open', 'global-pm']],
    ['the dashboard (no agent, no scope) sees everything', { agent: undefined, scope: undefined }, names(rows)],
    ['the dashboard scoped to project A sees global + A', { agent: undefined, scope: { projectId: 'A' } }, ['global-open', 'global-pm', 'a-open', 'a-pm']],
  ] as const)('%s', (_label, f, expected) => {
    expect(names(visibleBases(rows, { agent: f.agent, scope: f.scope }))).toEqual(expected);
  });

  it('`only` names one base (by name or id) but never widens the scope', () => {
    expect(names(visibleBases(rows, { agent: 'pm', scope: { projectId: 'A' }, only: 'a-pm' }))).toEqual(['a-pm']);
    expect(names(visibleBases(rows, { agent: 'pm', scope: { projectId: 'A' }, only: 'id-a-pm' }))).toEqual(['a-pm']);
    expect(names(visibleBases(rows, { agent: 'pm', scope: { projectId: 'A' }, only: 'b-open' }))).toEqual([]);
    expect(names(visibleBases(rows, { agent: 'dev', scope: { projectId: 'A' }, only: 'a-pm' }))).toEqual([]);
    expect(names(visibleBases(rows, { agent: 'pm', only: 'b-open' }))).toEqual(['b-open']); // no scope = the dashboard
  });

  it('rows without a projectId column (older fakes / rows) count as global', () => {
    expect(names(visibleBases([{ id: 'x', name: 'legacy', agents: [] }], { agent: 'pm', scope: { projectId: 'A' } }))).toEqual(['legacy']);
  });
});
