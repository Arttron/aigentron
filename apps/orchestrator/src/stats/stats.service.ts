import { Injectable } from '@nestjs/common';
import type { ProviderUsage, UsageReport } from '@lds/shared';
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
  async usageByProvider(range: { from?: Date; to?: Date }): Promise<UsageReport> {
    const startedAt: { gte?: Date; lte?: Date } = {};
    if (range.from) startedAt.gte = range.from;
    if (range.to) startedAt.lte = range.to;
    const where = range.from || range.to ? { startedAt } : {};

    const grouped = await this.prisma.agentSession.groupBy({
      by: ['provider'],
      where,
      _count: { _all: true },
      _sum: {
        inputTokens: true,
        outputTokens: true,
        cacheReadTokens: true,
        cacheCreationTokens: true,
        numTurns: true,
        costUsd: true,
      },
    });

    const providers: ProviderUsage[] = grouped
      .map((g) => ({
        provider: g.provider,
        sessions: g._count._all,
        requests: g._sum.numTurns ?? 0,
        inputTokens: g._sum.inputTokens ?? 0,
        outputTokens: g._sum.outputTokens ?? 0,
        cacheTokens: (g._sum.cacheReadTokens ?? 0) + (g._sum.cacheCreationTokens ?? 0),
        estCostUsd: g._sum.costUsd ?? 0,
      }))
      // Busiest first (by requests), stable tiebreak by provider name.
      .sort((a, b) => b.requests - a.requests || a.provider.localeCompare(b.provider));

    const totals = providers.reduce<Omit<ProviderUsage, 'provider'>>(
      (t, p) => ({
        sessions: t.sessions + p.sessions,
        requests: t.requests + p.requests,
        inputTokens: t.inputTokens + p.inputTokens,
        outputTokens: t.outputTokens + p.outputTokens,
        cacheTokens: t.cacheTokens + p.cacheTokens,
        estCostUsd: t.estCostUsd + p.estCostUsd,
      }),
      emptyTotals(),
    );

    return {
      from: range.from?.toISOString() ?? null,
      to: range.to?.toISOString() ?? null,
      totals,
      providers,
    };
  }
}
