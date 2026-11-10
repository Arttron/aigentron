import { BadRequestException, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectsService } from '../projects/projects.service';
import { isStatusFilter, statusesOf } from '../tasks/task-status-filter';
import {
  SEARCHABLE_KINDS,
  eventSearchText,
  fts5Query,
  groupHits,
  hasPhrases,
  checkPattern,
  isSearchable,
  parseQuery,
  pgQueryText,
  snippetFromRanges,
  snippetOf,
  unicodeAware,
  type EventHit,
} from './search-core';
import { scanTexts } from './pattern-scan';
import type { SearchChatsDto } from './search-chats.dto';

/** How many matching messages the index returns before the other filters narrow them. */
const CANDIDATES = 2000;
/** Old messages indexed per step of the backfill, and the pause between steps (it must never slow the server). */
const BACKFILL_BATCH = 300;
const BACKFILL_PAUSE_MS = 400;
/** A pattern search reads the latest messages only, and for at most this long. */
const PATTERN_SCAN_ROWS = 20_000;
const PATTERN_SCAN_MS = 4000;
const PATTERN_TEXT_CHARS = 20_000;

const KINDS_OF_SCOPE: Record<string, readonly string[]> = {
  all: SEARCHABLE_KINDS,
  mine: ['prompt'],
  agents: ['assistant', 'result', 'discussion'],
  results: ['result'],
};

export interface ChatSearchResult {
  tasks: {
    taskId: string;
    title: string;
    status: string;
    project: { slug: string; name: string } | null;
    agent: string | null;
    updatedAt: Date;
    hits: { eventId: string; line: string; kind: string; speaker: string | null; at: Date; snippet: { text: string; marks: [number, number][] } }[];
  }[];
  /** tasks that match (all pages) */
  total: number;
  /** messages that match (before the per-task cut) */
  messages: number;
  /** 0..1: how much of the history is indexed; results may be missing while it is below 1 */
  indexed: number;
  /** a pattern search: how many messages were read, and why the answer may be incomplete */
  pattern?: { scanned: number; truncated: boolean; timedOut: boolean };
}

/**
 * Search in the conversations of tasks (docs/chat-search.md). The words of a message are kept stemmed in `AgentEvent.searchText` (written when the event is
 * saved; old events by a background backfill), with a full-text index on it: a GIN index on Postgres, an FTS5 table on SQLite. The database finds and ranks the
 * candidates; the other filters, phrases, snippets and the grouping by task are done here, so both databases give the same answers.
 */
@Injectable()
export class ChatSearchService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ChatSearchService.name);
  private timer?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly projects: ProjectsService,
  ) {}

  onApplicationBootstrap(): void {
    // the backfill starts a little after boot, so that start-up is not slowed
    this.timer = setTimeout(() => void this.backfill(), 20_000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /** Indexes the messages saved before the index existed, in small steps. Safe to run again (it picks up what is still empty). */
  private async backfill(): Promise<void> {
    try {
      for (;;) {
        if (this.stopped) return;
        const rows = await this.prisma.agentEvent.findMany({
          where: { searchText: '', kind: { in: [...SEARCHABLE_KINDS] } },
          select: { id: true, kind: true, text: true },
          take: BACKFILL_BATCH,
        });
        if (!rows.length) return;
        await this.prisma.$transaction(rows.map((r) => this.prisma.agentEvent.update({ where: { id: r.id }, data: { searchText: eventSearchText(r.kind, r.text) } })));
        await new Promise((r) => (this.timer = setTimeout(r, BACKFILL_PAUSE_MS)));
      }
    } catch (e) {
      this.logger.warn(`indexing the old messages stopped: ${(e as Error).message}`);
    }
  }

  async status(): Promise<{ indexed: number; pending: number; total: number }> {
    const kinds = { in: [...SEARCHABLE_KINDS] };
    const [total, pending] = await Promise.all([this.prisma.agentEvent.count({ where: { kind: kinds } }), this.prisma.agentEvent.count({ where: { kind: kinds, searchText: '' } })]);
    return { total, pending, indexed: total === 0 ? 1 : (total - pending) / total };
  }

  /** The ids of the messages that hold all the words, best first (the database's own ranking; higher = better). */
  private async candidates(terms: string[], excluded: string[], kinds: readonly string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (this.config.storageDriver === 'sqlite') {
      const marks = kinds.map(() => '?').join(',');
      const rows = await this.prisma.$queryRawUnsafe<{ id: string; rank: number }[]>(
        `SELECT e."id" AS id, bm25("agent_event_fts") AS rank FROM "agent_event_fts" JOIN "AgentEvent" e ON e.rowid = "agent_event_fts".rowid WHERE "agent_event_fts" MATCH ? AND e."kind" IN (${marks}) ORDER BY rank LIMIT ${CANDIDATES}`,
        fts5Query(terms, excluded),
        ...kinds,
      );
      // bm25() is smaller for a better match (and negative): turn it around
      for (const r of rows) out.set(r.id, -Number(r.rank));
      return out;
    }
    const params: unknown[] = [pgQueryText(terms), [...kinds]];
    const notIn = excluded
      .map((w) => {
        params.push(w);
        return ` AND NOT (to_tsvector('simple', e."searchText") @@ plainto_tsquery('simple', $${params.length}))`;
      })
      .join('');
    const rows = await this.prisma.$queryRawUnsafe<{ id: string; rank: number }[]>(
      `SELECT e."id" AS id, ts_rank_cd(to_tsvector('simple', e."searchText"), q) AS rank FROM "AgentEvent" e, plainto_tsquery('simple', $1) q WHERE to_tsvector('simple', e."searchText") @@ q AND e."kind" = ANY($2::text[])${notIn} ORDER BY rank DESC LIMIT ${CANDIDATES}`,
      ...params,
    );
    for (const r of rows) out.set(r.id, Number(r.rank));
    return out;
  }

  /** The filters shared by both kinds of search: the task ids that pass (null = every task) and the date range. */
  private async filters(dto: SearchChatsDto, userId: string | null): Promise<{ taskIds: string[] | null; at: { gte?: Date; lte?: Date } }> {
    // the other filters are the task list's own: a project (an unknown slug matches nothing), an agent, a status, who created the task, and a date range
    const task: Record<string, unknown> = {};
    if (dto.project?.trim()) task.projectId = (await this.projects.get(dto.project.trim()).catch(() => null))?.id ?? '';
    if (dto.agent?.trim()) task.agentName = dto.agent.trim();
    if (isStatusFilter(dto.status)) task.status = { in: statusesOf(dto.status) };
    if (dto.scope === 'mine' && userId) task.createdById = userId;
    const at: { gte?: Date; lte?: Date } = {};
    const from = dto.from ? new Date(dto.from) : null;
    const to = dto.to ? new Date(dto.to) : null;
    if (from && !Number.isNaN(from.getTime())) at.gte = from;
    if (to && !Number.isNaN(to.getTime())) at.lte = new Date(to.getTime() + (dto.to!.length <= 10 ? 86_399_999 : 0));
    // an event has no relation to its task in the schema: the tasks that pass the filters are found first
    const taskIds = Object.keys(task).length ? (await this.prisma.task.findMany({ where: task as never, select: { id: true } })).map((t) => t.id) : null;
    return { taskIds, at };
  }

  async search(dto: SearchChatsDto, userId: string | null): Promise<ChatSearchResult> {
    const page = Math.max(1, dto.page ?? 1);
    const pageSize = Math.min(50, Math.max(1, dto.pageSize ?? 20));
    const { indexed } = await this.status();
    const empty: ChatSearchResult = { tasks: [], total: 0, messages: 0, indexed };
    const kinds = KINDS_OF_SCOPE[dto.scope ?? 'all'] ?? KINDS_OF_SCOPE.all!;
    const { taskIds, at } = await this.filters(dto, userId);
    if (taskIds && !taskIds.length) return empty;
    const hasAt = Boolean(at.gte || at.lte);

    const hits: EventHit[] = [];
    let pattern: ChatSearchResult['pattern'];
    if (dto.mode === 'pattern') {
      const checked = checkPattern(dto.q ?? '');
      if (!checked.ok) throw new BadRequestException(checked.error);
      // a pattern cannot use the word index: the latest messages that pass the filters are read and scanned (in a worker, with a time limit)
      const rows = await this.prisma.agentEvent.findMany({
        where: { kind: { in: [...kinds] }, ...(taskIds ? { taskId: { in: taskIds } } : {}), ...(hasAt ? { createdAt: at } : {}) },
        orderBy: { createdAt: 'desc' },
        take: PATTERN_SCAN_ROWS,
        select: { id: true, agentSessionId: true, seq: true, taskId: true, kind: true, speaker: true, text: true, createdAt: true },
      });
      const scan = await scanTexts(unicodeAware(dto.q!), rows.map((r) => r.text.slice(0, PATTERN_TEXT_CHARS)), PATTERN_SCAN_MS);
      pattern = { scanned: rows.length, truncated: rows.length >= PATTERN_SCAN_ROWS, timedOut: scan.timedOut };
      for (const [i, ranges] of scan.found) {
        const r = rows[i]!;
        hits.push({ eventId: r.id, line: `${r.agentSessionId}:${r.seq}`, taskId: r.taskId, kind: r.kind, speaker: r.speaker, at: new Date(r.createdAt), rank: 1, snippet: snippetFromRanges(r.text, ranges) });
      }
    } else {
      const parsed = parseQuery(dto.q ?? '');
      if (!isSearchable(parsed)) return empty;
      const ranks = await this.candidates(parsed.terms, parsed.excluded, kinds);
      if (!ranks.size) return empty;
      const rows = await this.prisma.agentEvent.findMany({
        where: { id: { in: [...ranks.keys()] }, ...(taskIds ? { taskId: { in: taskIds } } : {}), ...(hasAt ? { createdAt: at } : {}) },
        select: { id: true, agentSessionId: true, seq: true, taskId: true, kind: true, speaker: true, text: true, createdAt: true },
      });
      for (const r of rows) {
        if (!hasPhrases(r.text, parsed.phrases)) continue;
        hits.push({ eventId: r.id, line: `${r.agentSessionId}:${r.seq}`, taskId: r.taskId, kind: r.kind, speaker: r.speaker, at: new Date(r.createdAt), rank: ranks.get(r.id) ?? 0, snippet: snippetOf(r.text, parsed.terms, parsed.phrases) });
      }
    }
    if (!hits.length) return pattern ? { ...empty, pattern } : empty;

    let groups = groupHits(hits, Date.now());
    const tasks = await this.prisma.task.findMany({
      where: { id: { in: groups.map((g) => g.taskId) } },
      select: { id: true, title: true, status: true, agentName: true, updatedAt: true, project: { select: { slug: true, name: true } } },
    });
    const byId = new Map(tasks.map((t) => [t.id, t]));
    groups = groups.filter((g) => byId.has(g.taskId));
    if (dto.sort === 'new') groups.sort((a, b) => byId.get(b.taskId)!.updatedAt.getTime() - byId.get(a.taskId)!.updatedAt.getTime());
    const slice = groups.slice((page - 1) * pageSize, page * pageSize);
    return {
      total: groups.length,
      messages: hits.length,
      indexed,
      ...(pattern ? { pattern } : {}),
      tasks: slice.map((g) => {
        const t = byId.get(g.taskId)!;
        return {
          taskId: t.id,
          title: t.title,
          status: t.status,
          project: t.project ? { slug: t.project.slug, name: t.project.name } : null,
          agent: t.agentName,
          updatedAt: t.updatedAt,
          hits: g.hits.map((h) => ({ eventId: h.eventId, line: h.line, kind: h.kind, speaker: h.speaker, at: h.at, snippet: h.snippet })),
        };
      }),
    };
  }
}
