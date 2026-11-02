import { Injectable } from '@nestjs/common';
import type { AskUsage, CompressionUsage, DayUsage, EscalationUsage, ProjectUsage, ProviderUsage, UsageReport } from '@lds/shared';
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
      select: { startedAt: true, taskId: true, provider: true, inputTokens: true, outputTokens: true, cacheReadTokens: true, cacheCreationTokens: true, numTurns: true, costUsd: true, compressionBefore: true, compressionAfter: true, compressionSaved: true, model: true, escalationReason: true, escalatedFrom: true },
    });
    const taskIds = [...new Set(sessions.map((g) => g.taskId))];
    const projectOf = new Map<string, string>();
    const askTasks = new Set<string>();
    for (let i = 0; i < taskIds.length; i += 500) {
      const rows = await this.prisma.task.findMany({ where: { id: { in: taskIds.slice(i, i + 500) } }, select: { id: true, projectId: true, kind: true } });
      for (const r of rows) {
        projectOf.set(r.id, r.projectId);
        if (r.kind === 'ask') askTasks.add(r.id);
      }
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

    const emptyComp = (): CompressionUsage => ({ runs: 0, before: 0, after: 0, byRule: {} });
    const addComp = (into: CompressionUsage, g: (typeof sessions)[number]) => {
      if (!g.compressionBefore || (g.compressionAfter ?? 0) >= g.compressionBefore) return;
      into.runs += 1;
      into.before += g.compressionBefore;
      into.after += g.compressionAfter ?? 0;
      try {
        for (const [k, v] of Object.entries(JSON.parse(g.compressionSaved ?? '{}') as Record<string, number>)) into.byRule[k] = (into.byRule[k] ?? 0) + (Number(v) || 0);
      } catch {
        /* an unreadable breakdown only loses the per-rule split */
      }
    };
    const compression = emptyComp();
    const escalation: EscalationUsage = { runs: 0, tasks: 0, byReason: {}, paths: [] };
    const escalatedTasks = new Set<string>();
    const pathCount = new Map<string, number>();
    const ask: AskUsage = { tasks: 0, sessions: 0, inputTokens: 0, outputTokens: 0, estCostUsd: 0 };
    const askSeen = new Set<string>();
    const compByProject = new Map<string, CompressionUsage>();
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
      addComp(compByProject.get(pid) ?? (compByProject.set(pid, emptyComp()), compByProject.get(pid)!), g);
      if (wanted === null || pid === wanted) {
        addComp(compression, g);
        if (g.escalationReason) {
          escalation.runs += 1;
          escalatedTasks.add(g.taskId);
          escalation.byReason[g.escalationReason] = (escalation.byReason[g.escalationReason] ?? 0) + 1;
          const key = `${g.escalatedFrom ?? '?'}\u0000${g.provider}/${g.model}`;
          pathCount.set(key, (pathCount.get(key) ?? 0) + 1);
        }
        if (askTasks.has(g.taskId)) {
          ask.sessions += 1;
          ask.inputTokens += g.inputTokens ?? 0;
          ask.outputTokens += g.outputTokens ?? 0;
          ask.estCostUsd += g.costUsd ?? 0;
          askSeen.add(g.taskId);
        }
        add(slot(byProvider, g.provider), u);
        const day = dayOf(g.startedAt);
        add(byDay.get(day) ?? (byDay.set(day, emptyTotals()), byDay.get(day)!), u);
      }
    }
    const busiest = (a: ProviderUsage, b: ProviderUsage) => b.requests - a.requests || a.provider.localeCompare(b.provider);
    const providers: ProviderUsage[] = [...byProvider.values()].sort(busiest);
    const totals = providers.reduce<Omit<ProviderUsage, 'provider'>>((t, p) => (add(t, p), t), emptyTotals());
    const projects: ProjectUsage[] = [...byProject.entries()]
      .map(([pid, v]) => ({ slug: names.get(pid)?.slug ?? pid, name: names.get(pid)?.name ?? (pid || '(deleted project)'), totals: v.totals, providers: [...v.providers.values()].sort(busiest), compression: compByProject.get(pid) }))
      .sort((a, b) => b.totals.requests - a.totals.requests || a.name.localeCompare(b.name));

    escalation.tasks = escalatedTasks.size;
    escalation.paths = [...pathCount.entries()].map(([k, count]) => ({ from: k.split('\u0000')[0]!, to: k.split('\u0000')[1]!, count })).sort((a, b) => b.count - a.count).slice(0, 20);
    ask.tasks = askSeen.size;

    return {
      from: range.from?.toISOString() ?? null,
      to: range.to?.toISOString() ?? null,
      project: range.project?.trim() || null,
      totals,
      providers,
      projects,
      compression,
      escalation,
      ask,
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
