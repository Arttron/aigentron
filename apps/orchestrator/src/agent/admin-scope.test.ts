import { describe, expect, it, vi } from 'vitest';
import type { AdminToolsWiring } from '@lds/agent-runner';
import { scopeAdminTools, scopePrompt } from './admin-scope';

function fake() {
  const calls: Record<string, unknown[]> = {};
  const rec = (name: string, ret: unknown) => vi.fn(async (...a: unknown[]) => ((calls[name] ??= []).push(a), ret));
  const tools = new Proxy({} as Record<string, unknown>, { get: (t, k: string) => (t[k] ??= rec(k, k.startsWith('propose') || k === 'requestSecret' ? { ok: true, message: 'real ' + k } : 'real ' + k)) }) as unknown as AdminToolsWiring;
  return { tools, calls };
}
const owns = vi.fn(async (id: string) => id.startsWith('mine'));
const scope = { slug: 'shop', name: 'Shop', agents: ['support', 'writer'], canStartFor: (a: string) => ['support', 'writer'].includes(a), owns };

describe('the admin in a project chat', () => {
  it('platform administration is refused, read or change, and the real tool is never reached', async () => {
    const { tools, calls } = fake();
    const t = scopeAdminTools(tools, scope);
    for (const k of ['catalogList', 'providersList', 'channelsList', 'schedulesList', 'accessStatus', 'updateStatus', 'maintenanceReport', 'adminHistory', 'packsList']) {
      expect(await (t as never as Record<string, () => Promise<string>>)[k]!(), k).toContain('«Shop»');
    }
    expect(await t.agentGet('admin')).toContain('not available');
    for (const k of ['proposeAgent', 'proposeSkill', 'proposeAgentDelete', 'proposeBatch', 'proposeSettings', 'proposeUndo', 'requestSecret', 'proposeCleanup', 'proposeProvider', 'proposePackInstall', 'proposeChannel', 'proposeSchedule', 'proposeUpdate', 'proposeAllowedDomains', 'proposeCloudflareAccess']) {
      const r = await (t as never as Record<string, (i: unknown) => Promise<{ ok: boolean; message: string }>>)[k]!({});
      expect(r.ok, k).toBe(false);
      expect(r.message).toContain('Shop');
    }
    expect(Object.keys(calls)).toEqual([]);
  });
  it('the agent list is the project\'s own, names only', async () => {
    const t = scopeAdminTools(fake().tools, scope);
    const text = await t.agentsList();
    expect(text).toContain('support');
    expect(text).toContain('writer');
    expect(await scopeAdminTools(fake().tools, { ...scope, agents: [] }).agentsList()).toContain('no agents of its own');
  });
  it('tasks, usage, metrics and notes are always the project\'s, whatever the model asks for', async () => {
    const { tools, calls } = fake();
    const t = scopeAdminTools(tools, scope);
    await t.tasksList({ status: 'failed', project: 'other' } as never);
    await t.usageReport({ days: 3, project: 'other' } as never);
    await t.metricsReport({ topic: 'tasks', project: 'other' } as never);
    await t.proposeResource({ action: 'create', title: 'x', reason: 'r', project: 'other' });
    expect(calls.tasksList![0]).toEqual([{ status: 'failed', project: 'shop' }]);
    expect(calls.usageReport![0]).toEqual([{ days: 3, project: 'shop' }]);
    expect(calls.metricsReport![0]).toEqual([{ topic: 'tasks', project: 'shop' }]);
    expect((calls.proposeResource![0] as [{ project: string }])[0].project).toBe('shop');
  });
  it('a task of another project is not found, and cannot be cancelled or deleted from here', async () => {
    const { tools, calls } = fake();
    const t = scopeAdminTools(tools, scope);
    expect(await t.taskDiagnose('mine-1')).toBe('real taskDiagnose');
    expect(await t.taskDiagnose('theirs-1')).toContain('No task theirs-1');
    expect(await t.proposeTaskAction({ action: 'cancel', taskIds: ['mine-1', 'theirs-1'], reason: 'r' })).toMatchObject({ ok: false });
    expect(calls.proposeTaskAction).toBeUndefined();
    expect(await t.proposeTaskAction({ action: 'cancel', taskIds: ['mine-1', 'mine-2'], reason: 'r' })).toMatchObject({ ok: true });
  });
  it('the prompt names the project and forbids the tour of the platform', () => {
    const p = scopePrompt(scope);
    expect(p).toContain('«Shop»');
    expect(p).toContain('ONLY this project');
    expect(p).toContain('no tour');
  });
});

describe('starting work from a project chat', () => {
  it("a task is always the project's own, never a standalone one of the default project, and only for the project's agents", async () => {
    const { tools, calls } = fake();
    const t = scopeAdminTools(tools, scope);
    expect(await t.proposeTask({ agentName: 'support', prompt: 'p', standalone: true, reason: 'r' })).toMatchObject({ ok: true });
    expect(calls.proposeTask![0]).toEqual([{ agentName: 'support', prompt: 'p', standalone: false, reason: 'r' }]);
    const refused = await t.proposeTask({ agentName: 'devops', prompt: 'p', reason: 'r' });
    expect(refused).toMatchObject({ ok: false });
    expect(refused.message).toContain('support, writer');
    expect(calls.proposeTask).toHaveLength(1);
  });
});
