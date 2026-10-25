import { Injectable } from '@nestjs/common';
import type { DayUsage, ProjectUsage, ProviderUsage, UsageReport } from '@lds/shared';
import { PrismaService } from '../prisma/prisma.service';

/** Zeroed totals — the reduce seed and the empty-result response. */
function emptyTotals(): Omit<ProviderUsage, 'provider'> {
  return {
    sessions: 0,
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheTokens: 0,
    estCostUsd: 0,
  };
}

@Injectable()
export class StatsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Aggregate usage by provider over an optional [from, to] range (filtered on
   * `AgentSession.startedAt`). Each failover attempt is its own session, so
   * usage is attributed to the provider that actually ran. Sessions predating
   * the Phase-1 usage-capture deploy have null usage columns and sum as 0.
   */
  async usageByProvider(range: { from?: Date; to?: Date; project?: string; /** minutes behind UTC of the viewer, as `Date.getTimezoneOffset()` (days are theirs) */ tzOffsetMin?: number }): Promise<UsageReport> {
    const startedAt: { gte?: Date; lte?: Date } = {};
    if (range.from) startedAt.gte = range.from;
    if (range.to) startedAt.lte = range.to;
    const where = range.from || range.to ? { startedAt } : {};

    const sessions = await this.prisma.agentSession.findMany({
      where,
      select: { startedAt: true, taskId: true, provider: true, inputTokens: true, outputTokens: true, cacheReadTokens: true, cacheCreationTokens: true, numTurns: true, costUsd: true },
    });
    const taskIds = [...new Set(sessions.map((g) => g.taskId))];
    const projectOf = new Map<string, string>();
    for (let i = 0; i < taskIds.length; i += 500) {
      const rows = await this.prisma.task.findMany({ where: { id: { in: taskIds.slice(i, i + 500) } }, select: { id: true, projectId: true } });
      for (const r of rows) projectOf.set(r.id, r.projectId);
    }
    const names = new Map((await this.prisma.project.findMany({ select: { id: true, slug: true, name: true } })).map((p) => [p.id, p]));
    const wanted = range.project?.trim() ? [...names.values()].find((p) => p.slug === range.project!.trim())?.id ?? '' : null;
    const tz = Number.isFinite(range.tzOffsetMin) ? Math.max(-840, Math.min(840, range.tzOffsetMin!)) : 0;

    const one = (provider: string, g: (typeof sessions)[number]): ProviderUsage => ({
      provider,
      sessions: 1,
      requests: g.numTurns ?? 0,
      inputTokens: g.inputTokens ?? 0,
      outputTokens: g.outputTokens ?? 0,
      cacheTokens: (g.cacheReadTokens ?? 0) + (g.cacheCreationTokens ?? 0),
      estCostUsd: g.costUsd ?? 0,
    });
    const add = (into: Omit<ProviderUsage, 'provider'>, u: ProviderUsage) => {
      into.sessions += u.sessions;
      into.requests += u.requests;
      into.inputTokens += u.inputTokens;
      into.outputTokens += u.outputTokens;
      into.cacheTokens += u.cacheTokens;
      into.estCostUsd += u.estCostUsd;
    };
    const slot = (m: Map<string, ProviderUsage>, provider: string): ProviderUsage => m.get(provider) ?? (m.set(provider, { ...emptyTotals(), provider }), m.get(provider)!);
    const dayOf = (d: Date): string => new Date(d.getTime() - tz * 60_000).toISOString().slice(0, 10);

    const byProvider = new Map<string, ProviderUsage>();
    const byProject = new Map<string, { totals: Omit<ProviderUsage, 'provider'>; providers: Map<string, ProviderUsage> }>();
    const byDay = new Map<string, Omit<ProviderUsage, 'provider'>>();
    for (const g of sessions) {
      const u = one(g.provider, g);
      const pid = projectOf.get(g.taskId) ?? '';
      const proj = byProject.get(pid) ?? { totals: emptyTotals(), providers: new Map() };
      add(proj.totals, u);
      add(slot(proj.providers, g.provider), u);
      byProject.set(pid, proj);
      if (wanted === null || pid === wanted) {
        add(slot(byProvider, g.provider), u);
        const day = dayOf(g.startedAt);
        add(byDay.get(day) ?? (byDay.set(day, emptyTotals()), byDay.get(day)!), u);
      }
    }
    const busiest = (a: ProviderUsage, b: ProviderUsage) => b.requests - a.requests || a.provider.localeCompare(b.provider);
    const providers: ProviderUsage[] = [...byProvider.values()].sort(busiest);
    const totals = providers.reduce<Omit<ProviderUsage, 'provider'>>((t, p) => (add(t, p), t), emptyTotals());
    const projects: ProjectUsage[] = [...byProject.entries()]
      .map(([pid, v]) => ({ slug: names.get(pid)?.slug ?? pid, name: names.get(pid)?.name ?? (pid || '(deleted project)'), totals: v.totals, providers: [...v.providers.values()].sort(busiest) }))
      .sort((a, b) => b.totals.requests - a.totals.requests || a.name.localeCompare(b.name));

    return {
      from: range.from?.toISOString() ?? null,
      to: range.to?.toISOString() ?? null,
      project: range.project?.trim() || null,
      totals,
      providers,
      projects,
      days: fillDays(byDay, range.from ? dayOf(range.from) : null, dayOf(range.to ?? new Date())),
    };
  }
}

/** Days from the first with usage (or `first`) to `last`, oldest first, quiet days as zeros (so a chart has no holes); at most a year back from `last`. */
export function fillDays(byDay: Map<string, Omit<ProviderUsage, 'provider'>>, first: string | null, last: string): DayUsage[] {
  const keys = [...byDay.keys()].sort();
  if (!keys.length) return [];
  let from = first && first < keys[0]! ? first : keys[0]!;
  const end = keys[keys.length - 1]! > last ? keys[keys.length - 1]! : last;
  const floor = new Date(Date.parse(`${end}T00:00:00Z`) - 365 * 86_400_000).toISOString().slice(0, 10);
  if (from < floor) from = floor;
  const out: DayUsage[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${end}T00:00:00Z`); t += 86_400_000) {
    const date = new Date(t).toISOString().slice(0, 10);
    out.push({ date, totals: byDay.get(date) ?? emptyTotals() });
  }
  return out;
}
