import { describe, expect, it } from 'vitest';
import { StatsService, fillDays } from './stats.service';

const row = (taskId: string, provider: string, at: string, over: Partial<Record<string, number>> = {}) => ({
  startedAt: new Date(at),
  taskId,
  provider,
  inputTokens: 100,
  outputTokens: 10,
  cacheReadTokens: 50,
  cacheCreationTokens: 0,
  numTurns: 2,
  costUsd: 0.5,
  ...over,
});

function service(rows: ReturnType<typeof row>[]) {
  const prisma = {
    agentSession: { findMany: async () => rows },
    task: { findMany: async () => [{ id: 't1', projectId: 'p-shop', kind: 'task' }, { id: 't2', projectId: 'p-blog', kind: 'task' }, { id: 't3', projectId: 'p-shop', kind: 'ask' }] },
    project: { findMany: async () => [{ id: 'p-shop', slug: 'shop', name: 'Shop' }, { id: 'p-blog', slug: 'blog', name: 'Blog' }] },
  };
  return new StatsService(prisma as never);
}
const data = [
  row('t1', 'claude', '2026-10-20T10:00:00Z'),
  row('t3', 'ollama', '2026-10-20T23:30:00Z', { costUsd: 0, numTurns: 5 }),
  row('t2', 'claude', '2026-10-22T09:00:00Z', { inputTokens: 1000 }),
];

describe('escalations and questions', () => {
  it('counts escalated runs by reason and path, and the cost of questions', async () => {
    const esc = (taskId: string, reason: string, from: string, over: object = {}) => row(taskId, 'claude', '2026-10-20T10:00:00Z', { model: 'opus', escalationReason: reason as never, escalatedFrom: from as never, ...over });
    const r = await service([esc('t1', 'verification failed', 'claude/haiku'), esc('t1', 'ran out of time', 'claude/haiku'), esc('t2', 'verification failed', 'claude/haiku'), row('t3', 'claude', '2026-10-20T11:00:00Z', { inputTokens: 500, outputTokens: 20, costUsd: 0.25 })]).usageByProvider({});
    expect(r.escalation).toMatchObject({ runs: 3, tasks: 2, byReason: { 'verification failed': 2, 'ran out of time': 1 } });
    expect(r.escalation!.paths).toEqual([{ from: 'claude/haiku', to: 'claude/opus', count: 3 }]);
    expect(r.ask).toEqual({ tasks: 1, sessions: 1, inputTokens: 500, outputTokens: 20, estCostUsd: 0.25 });
    const limited = await service([esc('t1', 'x', 'a/b'), esc('t2', 'y', 'a/b')]).usageByProvider({ project: 'blog' });
    expect(limited.escalation).toMatchObject({ runs: 1, tasks: 1 });
  });
});

describe('what the text filters saved', () => {
  it('sums characters and the per-rule split, per project too; runs without savings do not count', async () => {
    const withComp = (taskId: string, before: number, after: number, saved: object) => row(taskId, 'claude', '2026-10-20T10:00:00Z', { compressionBefore: before, compressionAfter: after, compressionSaved: JSON.stringify(saved) as never });
    const r = await service([withComp('t1', 1000, 600, { whitespace: 100, logs: 300 }), withComp('t2', 500, 400, { whitespace: 100 }), row('t3', 'claude', '2026-10-20T11:00:00Z')]).usageByProvider({});
    expect(r.compression).toEqual({ runs: 2, before: 1500, after: 1000, byRule: { whitespace: 200, logs: 300 } });
    expect(r.projects!.find((p) => p.slug === 'shop')!.compression).toMatchObject({ runs: 1, before: 1000, after: 600 });
    const limited = await service([withComp('t1', 1000, 600, { whitespace: 400 }), withComp('t2', 500, 400, { whitespace: 100 })]).usageByProvider({ project: 'blog' });
    expect(limited.compression).toMatchObject({ runs: 1, before: 500 });
  });
});

describe('usage report', () => {
  it('by provider, by project and by day from the same sessions', async () => {
    const r = await service(data).usageByProvider({ to: new Date('2026-10-22T23:00:00Z') });
    expect(r.providers.map((p) => [p.provider, p.sessions, p.requests])).toEqual([['ollama', 1, 5], ['claude', 2, 4]]);
    expect(r.totals).toMatchObject({ sessions: 3, inputTokens: 1200, cacheTokens: 150 });
    expect(r.projects!.map((p) => [p.slug, p.totals.sessions])).toEqual([['shop', 2], ['blog', 1]]);
    expect(r.projects![0]!.providers.map((p) => p.provider).sort()).toEqual(['claude', 'ollama']);
    expect(r.days!.map((d) => [d.date, d.totals.sessions])).toEqual([['2026-10-20', 2], ['2026-10-21', 0], ['2026-10-22', 1]]); // the quiet day is there as zeros
  });
  it('a project limits the provider rows, the totals and the days — not the list of projects', async () => {
    const r = await service(data).usageByProvider({ project: 'blog', to: new Date('2026-10-22T23:00:00Z') });
    expect(r.project).toBe('blog');
    expect(r.providers.map((p) => p.provider)).toEqual(['claude']);
    expect(r.totals.sessions).toBe(1);
    expect(r.days!.reduce((n, d) => n + d.totals.sessions, 0)).toBe(1);
    expect(r.projects).toHaveLength(2);
    expect((await service(data).usageByProvider({ project: 'nope' })).providers).toEqual([]);
  });
  it('days are the viewer\'s: a late-evening UTC session lands on the next day for someone ahead of UTC', async () => {
    const r = await service(data).usageByProvider({ tzOffsetMin: -120, to: new Date('2026-10-22T23:00:00Z') }); // UTC+2
    expect(r.days!.find((d) => d.date === '2026-10-21')!.totals.sessions).toBe(1); // 23:30Z → 01:30 next day
  });
});

describe('fillDays', () => {
  it('nothing → nothing; gaps filled; never more than a year', () => {
    expect(fillDays(new Map(), null, '2026-10-22')).toEqual([]);
    const z = { sessions: 1, requests: 0, inputTokens: 0, outputTokens: 0, cacheTokens: 0, estCostUsd: 0 };
    expect(fillDays(new Map([['2026-10-20', z], ['2026-10-23', z]]), null, '2026-10-23').map((d) => d.date)).toEqual(['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23']);
    expect(fillDays(new Map([['2020-01-01', z]]), null, '2026-10-23').length).toBeLessThanOrEqual(366);
  });
});
