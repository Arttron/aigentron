import { describe, expect, it } from 'vitest';
import { DiscussionService } from './discussion.service';
import { AGREED_MARK } from './discussion-core';

type Fake = { statuses: string[]; events: { kind: string; speaker?: string; text: string }[]; calls: string[] };

function make(opts: { reply: (agent: string, n: number) => { text?: string; error?: string }; taskStatus?: () => string }) {
  const fake: Fake = { statuses: [], events: [], calls: [] };
  let n = 0;
  const prisma = {
    task: { findUnique: async () => ({ status: opts.taskStatus?.() ?? 'running' }) },
    agentSession: { findFirst: async () => ({ id: 's1' }) },
    agentEvent: { create: async ({ data }: { data: { kind: string; speaker?: string; text: string } }) => void fake.events.push(data), count: async () => 0 },
  };
  const tasks = {
    get: async () => ({ id: 't1', status: 'done' }),
    setStatus: async (_id: string, s: string) => void fake.statuses.push(s),
    create: async () => ({ id: 't1' }),
  };
  const executor = {
    cancel: () => undefined,
    run: async (ctx: { discussion: { agent: string; collect: { text: string; error?: string } } }) => {
      fake.calls.push(ctx.discussion.agent);
      const r = opts.reply(ctx.discussion.agent, n++);
      if (r.error) {
        ctx.discussion.collect.error = r.error;
        return { reported: null, errored: true, timedOut: false };
      }
      ctx.discussion.collect.text = r.text ?? '';
      return { reported: null, errored: false, timedOut: false };
    },
    // never used here
  };
  const agents = { list: async () => ['pm', 'dev', 'qa'].map((name) => ({ name, description: '' })) };
  const svc = new DiscussionService(prisma as never, { publish: () => undefined } as never, tasks as never, executor as never, agents as never, { agentDir: '/tmp/lds-test-agent' } as never);
  return { svc, fake };
}

const settled = async (svc: DiscussionService, id: string) => {
  for (let i = 0; i < 200 && svc.isActive(id); i++) await new Promise((r) => setTimeout(r, 5));
};

describe('DiscussionService', () => {
  it('plays rounds × participants turns in order, then the conclusion, and finishes the chat', async () => {
    const { svc, fake } = make({ reply: (a) => ({ text: `${a} says something` }) });
    const { taskId } = await svc.start({ topic: 'T', agents: ['pm', 'dev'], rounds: 2, summaryBy: 'pm' });
    await settled(svc, taskId);
    expect(fake.calls).toEqual(['pm', 'dev', 'pm', 'dev', 'pm']);
    expect(fake.statuses).toEqual(['running', 'review']); // a person accepts the result
  });
  it('stops early when a whole round agrees', async () => {
    const { svc, fake } = make({ reply: () => ({ text: `fine ${AGREED_MARK}` }) });
    const { taskId } = await svc.start({ topic: 'T', agents: ['pm', 'dev'], rounds: 4 });
    await settled(svc, taskId);
    expect(fake.calls.length).toBe(2);
    expect(fake.events.some((e) => e.speaker === 'system' && /agrees/.test(e.text))).toBe(true);
  });
  it('an error is never a reply: two failed turns end the discussion as failed, and nothing is said by the failing agent', async () => {
    const { svc, fake } = make({ reply: () => ({ error: 'API Error 401' }) });
    const { taskId } = await svc.start({ topic: 'T', agents: ['pm', 'dev'], rounds: 3 });
    await settled(svc, taskId);
    expect(fake.calls.length).toBe(2);
    expect(fake.statuses[fake.statuses.length - 1]).toBe('failed');
    expect(fake.events.filter((e) => e.speaker && e.speaker !== 'system')).toEqual([]);
  });
  it('a cancelled chat ends the loop without touching its status', async () => {
    let status = 'running';
    const { svc, fake } = make({ reply: (_a, n) => { if (n === 0) status = 'cancelled'; return { text: 'x' }; }, taskStatus: () => status });
    const { taskId } = await svc.start({ topic: 'T', agents: ['pm', 'dev'], rounds: 3 });
    await settled(svc, taskId);
    expect(fake.calls.length).toBe(1);
    expect(fake.statuses).toEqual(['running']);
  });
  it('wrap-up skips to the conclusion; built-in agents and one-person "discussions" are refused', async () => {
    const { svc, fake } = make({ reply: () => ({ text: 'x' }) });
    const started = await svc.start({ topic: 'T', agents: ['pm', 'dev'], rounds: 6, summaryBy: 'dev' });
    svc.conclude(started.taskId);
    await settled(svc, started.taskId);
    expect(fake.calls.length).toBeLessThanOrEqual(3);
    expect(fake.calls[fake.calls.length - 1]).toBe('dev');
    await expect(svc.start({ topic: 'T', agents: ['pm'] })).rejects.toThrow();
    await expect(svc.start({ topic: 'T', agents: ['pm', 'admin'] })).rejects.toThrow();
  });
});
