import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { extractDocument } from './extract';
import { ProvidersService } from '../providers/providers.service';
import { ResourcesService } from '../resources/resources.service';
import {
  Bm25Index,
  chunkText,
  cleanChunking,
  decodeVector,
  encodeVector,
  fuseRanks,
  htmlToText,
  topBySimilarity,
  type ChunkingConfig,
  type Scored,
} from './kb-core';

export interface KbInfo {
  id: string;
  name: string;
  description: string;
  agents: string[];
  chunking: ChunkingConfig;
  embedProvider: string | null;
  embedModel: string | null;
  embedDim: number | null;
  agentWrite: boolean;
  docs: number;
  chunks: number;
  embedded: number;
  createdAt: string;
}

export interface KbDocInfo {
  id: string;
  title: string;
  source: string | null;
  kind: string;
  size: number;
  chunks: number;
  createdAt: string;
}

export interface KbHit {
  kb: string;
  docId: string;
  docTitle: string;
  source: string | null;
  chunk: number;
  heading: string;
  text: string;
  score: number;
}

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/i;
const MAX_TEXT_CHARS = 5_000_000;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_CHUNKS_PER_KB = 60_000;
const EMBED_BATCH = 32;

interface Row {
  chunkId: string;
  docId: string;
  docTitle: string;
  source: string | null;
  idx: number;
  heading: string;
  text: string;
}
interface Loaded {
  rows: Row[];
  bm25: Bm25Index;
  vectors: (Float32Array | null)[];
}

/**
 * The knowledge base: documents are cut into chunks and kept in the app's own database (Postgres or SQLite alike); searching is BM25
 * in memory (no extension, no key needed) and, when a base has an embedding model, hybrid — the vector ranking is fused with BM25.
 * An in-memory index per base is rebuilt lazily after any change.
 */
@Injectable()
export class KnowledgeService {
  private readonly logger = new Logger(KnowledgeService.name);
  private readonly cache = new Map<string, Loaded>();
  private readonly embedding = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly providers: ProvidersService,
    private readonly config: AppConfigService,
    private readonly resources: ResourcesService,
  ) {}

  // ------------------------------------------------------------- bases

  private async toInfo(row: Awaited<ReturnType<PrismaService['knowledgeBase']['findFirstOrThrow']>>): Promise<KbInfo> {
    const [docs, chunks, embedded] = await Promise.all([
      this.prisma.knowledgeDoc.count({ where: { kbId: row.id } }),
      this.prisma.knowledgeChunk.count({ where: { kbId: row.id } }),
      this.prisma.knowledgeChunk.count({ where: { kbId: row.id, embedding: { not: null } } }),
    ]);
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      agents: Array.isArray(row.agents) ? (row.agents as unknown[]).map(String) : [],
      chunking: cleanChunking(row.chunking as Partial<ChunkingConfig>),
      embedProvider: row.embedProvider,
      embedModel: row.embedModel,
      embedDim: row.embedDim,
      agentWrite: row.agentWrite,
      docs,
      chunks,
      embedded,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async list(): Promise<KbInfo[]> {
    const rows = await this.prisma.knowledgeBase.findMany({ orderBy: { name: 'asc' } });
    return Promise.all(rows.map((r) => this.toInfo(r)));
  }

  private async row(name: string) {
    const r = await this.prisma.knowledgeBase.findFirst({ where: { OR: [{ name }, { id: name }] } });
    if (!r) throw new NotFoundException(`No knowledge base named "${name}".`);
    return r;
  }

  async get(name: string): Promise<KbInfo> {
    return this.toInfo(await this.row(name));
  }

  async create(input: { name?: string; description?: string; agents?: unknown; chunking?: Partial<ChunkingConfig>; agentWrite?: boolean; embedProvider?: string; embedModel?: string }): Promise<KbInfo> {
    const name = String(input.name ?? '').trim();
    if (!NAME_RE.test(name)) throw new BadRequestException('The name: letters, digits, "-" or "_" (up to 40), e.g. building-codes.');
    if (await this.prisma.knowledgeBase.findUnique({ where: { name } })) throw new ConflictException(`A knowledge base named "${name}" already exists.`);
    const embed = await this.checkEmbedding(input.embedProvider, input.embedModel);
    const row = await this.prisma.knowledgeBase.create({
      data: {
        name,
        description: String(input.description ?? '').trim().slice(0, 500),
        agents: this.cleanAgents(input.agents),
        chunking: cleanChunking(input.chunking) as never,
        agentWrite: Boolean(input.agentWrite),
        ...embed,
      },
    });
    return this.toInfo(row);
  }

  async update(name: string, input: { description?: string; agents?: unknown; chunking?: Partial<ChunkingConfig>; agentWrite?: boolean; embedProvider?: string | null; embedModel?: string | null }): Promise<KbInfo> {
    const cur = await this.row(name);
    const data: Record<string, unknown> = {};
    if (input.description !== undefined) data.description = String(input.description).trim().slice(0, 500);
    if (input.agents !== undefined) data.agents = this.cleanAgents(input.agents);
    if (input.chunking !== undefined) data.chunking = cleanChunking(input.chunking);
    if (input.agentWrite !== undefined) data.agentWrite = Boolean(input.agentWrite);
    let reembed = false;
    if (input.embedProvider !== undefined || input.embedModel !== undefined) {
      const provider = input.embedProvider === undefined ? cur.embedProvider : input.embedProvider;
      const model = input.embedModel === undefined ? cur.embedModel : input.embedModel;
      const embed = await this.checkEmbedding(provider ?? undefined, model ?? undefined);
      if (embed.embedProvider !== cur.embedProvider || embed.embedModel !== cur.embedModel) {
        Object.assign(data, embed);
        // old vectors belong to the old model — drop them; new ones are made in the background
        await this.prisma.knowledgeChunk.updateMany({ where: { kbId: cur.id }, data: { embedding: null } });
        reembed = Boolean(embed.embedProvider);
      }
    }
    const row = await this.prisma.knowledgeBase.update({ where: { id: cur.id }, data });
    this.cache.delete(cur.id);
    if (reembed) void this.embedMissing(cur.id).catch((e) => this.logger.warn(`embedding "${cur.name}" failed: ${(e as Error).message}`));
    return this.toInfo(row);
  }

  async remove(name: string): Promise<void> {
    const cur = await this.row(name);
    await this.prisma.knowledgeBase.delete({ where: { id: cur.id } }); // documents and chunks cascade
    this.cache.delete(cur.id);
  }

  private cleanAgents(v: unknown): string[] {
    return Array.isArray(v) ? [...new Set(v.map((a) => String(a).trim()).filter(Boolean))].slice(0, 50) : [];
  }

  private async checkEmbedding(provider?: string | null, model?: string | null): Promise<{ embedProvider: string | null; embedModel: string | null }> {
    const p = (provider ?? '').trim();
    if (!p) return { embedProvider: null, embedModel: null };
    const m = (model ?? '').trim() || (await this.defaultEmbedModel(p));
    try {
      const v = await this.embed(p, m, ['test']);
      if (!v[0]?.length) throw new Error('the provider returned no vector');
    } catch (e) {
      throw new BadRequestException(`Embeddings with ${p} / ${m} do not work: ${(e as Error).message}`);
    }
    return { embedProvider: p, embedModel: m };
  }

  private async defaultEmbedModel(provider: string): Promise<string> {
    const info = await this.providers.get(provider).catch(() => null);
    return info?.kind === 'ollama' ? 'nomic-embed-text' : 'text-embedding-3-small';
  }

  // --------------------------------------------------------- embeddings

  /** Vectors for a list of texts from a provider's OpenAI-style /embeddings endpoint. */
  async embed(provider: string, model: string, texts: string[]): Promise<number[][]> {
    const ep = await this.providers.embeddingEndpoint(provider, model);
    const res = await fetch(ep.url, {
      method: 'POST',
      headers: { ...ep.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ model: ep.model, input: texts }),
      signal: AbortSignal.timeout(120_000),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    const data = (JSON.parse(body) as { data?: { embedding: number[]; index?: number }[] }).data ?? [];
    return data.sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((d) => d.embedding);
  }

  /** Make vectors for every chunk of a base that has none (background; one run per base at a time). */
  async embedMissing(kbId: string): Promise<number> {
    if (this.embedding.has(kbId)) return 0;
    this.embedding.add(kbId);
    let done = 0;
    try {
      const kb = await this.prisma.knowledgeBase.findUnique({ where: { id: kbId } });
      if (!kb?.embedProvider || !kb.embedModel) return 0;
      for (;;) {
        const batch = await this.prisma.knowledgeChunk.findMany({ where: { kbId, embedding: null }, orderBy: [{ docId: 'asc' }, { idx: 'asc' }], take: EMBED_BATCH });
        if (!batch.length) break;
        const vectors = await this.embed(kb.embedProvider, kb.embedModel, batch.map((c) => `${c.heading ? `${c.heading}\n` : ''}${c.text}`.slice(0, 8000)));
        if (vectors.length !== batch.length) throw new Error('the provider returned a different number of vectors');
        for (let i = 0; i < batch.length; i++) {
          await this.prisma.knowledgeChunk.update({ where: { id: batch[i]!.id }, data: { embedding: encodeVector(vectors[i]!) } });
        }
        if (!kb.embedDim) await this.prisma.knowledgeBase.update({ where: { id: kbId }, data: { embedDim: vectors[0]!.length } });
        done += batch.length;
        this.cache.delete(kbId);
      }
    } finally {
      this.embedding.delete(kbId);
    }
    return done;
  }

  // --------------------------------------------------------- documents

  /** Add one document: chunk it by the base's settings, store the chunks, embed them when the base has a model. */
  async addDocument(kbName: string, input: { title?: string; text: string; source?: string | null; kind?: string }): Promise<{ docId: string; chunks: number; duplicate: boolean }> {
    const kb = await this.row(kbName);
    const text = String(input.text ?? '');
    if (!text.trim()) throw new BadRequestException('The document is empty.');
    if (text.length > MAX_TEXT_CHARS) throw new BadRequestException(`The document is too long (${Math.round(text.length / 1000)}k characters; the limit is ${MAX_TEXT_CHARS / 1_000_000}M).`);
    const hash = createHash('sha256').update(text.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 32);
    const dup = await this.prisma.knowledgeDoc.findUnique({ where: { kbId_hash: { kbId: kb.id, hash } } });
    if (dup) return { docId: dup.id, chunks: await this.prisma.knowledgeChunk.count({ where: { docId: dup.id } }), duplicate: true };
    const chunks = chunkText(text, cleanChunking(kb.chunking as Partial<ChunkingConfig>));
    if (!chunks.length) throw new BadRequestException('Nothing to index in that text.');
    const have = await this.prisma.knowledgeChunk.count({ where: { kbId: kb.id } });
    if (have + chunks.length > MAX_CHUNKS_PER_KB) throw new BadRequestException(`This base would exceed ${MAX_CHUNKS_PER_KB} chunks — remove some documents first.`);
    const title = (input.title ?? '').trim().slice(0, 200) || (text.trim().split('\n')[0] ?? 'Untitled').replace(/^#+\s*/, '').slice(0, 120);
    const doc = await this.prisma.knowledgeDoc.create({
      data: {
        kbId: kb.id,
        title,
        source: input.source ? String(input.source).slice(0, 500) : null,
        kind: input.kind ?? 'file',
        hash,
        size: text.length,
        chunks: { create: chunks.map((c, i) => ({ kbId: kb.id, idx: i, heading: c.heading, text: c.text })) },
      },
    });
    this.cache.delete(kb.id);
    if (kb.embedProvider) void this.embedMissing(kb.id).catch((e) => this.logger.warn(`embedding "${kb.name}" failed: ${(e as Error).message}`));
    return { docId: doc.id, chunks: chunks.length, duplicate: false };
  }

  async addFile(kbName: string, fileName: string, data: Buffer, title?: string): Promise<{ docId: string; chunks: number; duplicate: boolean }> {
    if (data.length > MAX_FILE_BYTES) throw new BadRequestException(`The file is too large (${Math.round(data.length / 1048576)} MB; the limit is ${MAX_FILE_BYTES / 1048576} MB).`);
    let text: string;
    try {
      text = await extractDocument(fileName, data);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
    return this.addDocument(kbName, { title: title || fileName.replace(/\.\w+$/, ''), text, source: fileName, kind: 'file' });
  }

  /** A page from the resource library (a text note or a text-like file). */
  async importResource(kbName: string, resourceId: string): Promise<{ docId: string; chunks: number; duplicate: boolean }> {
    const r = await this.resources.get(resourceId);
    const data = await readFile(this.resources.pathOf(r)).catch(() => null);
    if (!data) throw new NotFoundException('The resource file is missing.');
    let text: string;
    try {
      text = r.kind === 'text' ? data.toString('utf8') : await extractDocument(r.originalName, data);
    } catch (e) {
      throw new BadRequestException(`The resource "${r.title}": ${(e as Error).message}`);
    }
    return this.addDocument(kbName, { title: r.title, text, source: `resource:${r.id}`, kind: 'resource' });
  }

  /** Pages the research tools fetched (agent/research-cache/*.json) → documents with their source URL. */
  async importResearch(kbName: string): Promise<{ added: number; skipped: number }> {
    const dir = join(this.config.agentDir, 'research-cache');
    const files = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith('.json'));
    let added = 0;
    let skipped = 0;
    for (const f of files) {
      try {
        const p = JSON.parse(await readFile(join(dir, f), 'utf8')) as { url?: string; finalUrl?: string; title?: string; fetchedAt?: string; contentType?: string; text?: string };
        const text = /html/i.test(p.contentType ?? '') && /<\w+[^>]*>/.test(p.text ?? '') ? htmlToText(p.text ?? '') : (p.text ?? '');
        if (!text.trim()) {
          skipped++;
          continue;
        }
        const r = await this.addDocument(kbName, { title: p.title || p.finalUrl || p.url, text, source: p.finalUrl || p.url || null, kind: 'research' });
        if (r.duplicate) skipped++;
        else added++;
      } catch {
        skipped++;
      }
    }
    return { added, skipped };
  }

  async listDocs(kbName: string): Promise<KbDocInfo[]> {
    const kb = await this.row(kbName);
    const docs = await this.prisma.knowledgeDoc.findMany({ where: { kbId: kb.id }, orderBy: { createdAt: 'desc' }, include: { _count: { select: { chunks: true } } } });
    return docs.map((d) => ({ id: d.id, title: d.title, source: d.source, kind: d.kind, size: d.size, chunks: d._count.chunks, createdAt: d.createdAt.toISOString() }));
  }

  async removeDoc(docId: string): Promise<void> {
    const d = await this.prisma.knowledgeDoc.findUnique({ where: { id: docId } });
    if (!d) throw new NotFoundException('No such document.');
    await this.prisma.knowledgeDoc.delete({ where: { id: docId } });
    this.cache.delete(d.kbId);
  }

  /** Dry run: how a text would be cut with these settings (nothing is stored). */
  preview(text: string, chunking?: Partial<ChunkingConfig>): { chunks: { heading: string; chars: number; text: string }[]; total: number; avg: number; max: number } {
    const all = chunkText(String(text ?? '').slice(0, MAX_TEXT_CHARS), cleanChunking(chunking));
    const sizes = all.map((c) => c.text.length);
    return {
      total: all.length,
      avg: all.length ? Math.round(sizes.reduce((a, b) => a + b, 0) / all.length) : 0,
      max: sizes.length ? Math.max(...sizes) : 0,
      chunks: all.slice(0, 8).map((c) => ({ heading: c.heading, chars: c.text.length, text: c.text.slice(0, 400) })),
    };
  }

  // ------------------------------------------------------------- search

  private async load(kbId: string): Promise<Loaded> {
    const hit = this.cache.get(kbId);
    if (hit) return hit;
    const chunks = await this.prisma.knowledgeChunk.findMany({ where: { kbId }, orderBy: [{ docId: 'asc' }, { idx: 'asc' }], include: { doc: { select: { title: true, source: true } } } });
    const bm25 = new Bm25Index();
    const rows: Row[] = [];
    const vectors: (Float32Array | null)[] = [];
    for (const c of chunks) {
      bm25.add(`${c.doc.title} ${c.heading}`, c.text);
      rows.push({ chunkId: c.id, docId: c.docId, docTitle: c.doc.title, source: c.doc.source, idx: c.idx, heading: c.heading, text: c.text });
      vectors.push(c.embedding ? decodeVector(c.embedding) : null);
    }
    const loaded = { rows, bm25, vectors };
    this.cache.set(kbId, loaded);
    return loaded;
  }

  /** Search one or all visible bases. `agent` limits it to the bases that agent may use. */
  async search(query: string, opts: { kb?: string; agent?: string; limit?: number } = {}): Promise<{ hits: KbHit[]; note?: string }> {
    const q = String(query ?? '').trim();
    if (!q) throw new BadRequestException('Give a search query.');
    const limit = Math.min(Math.max(opts.limit ?? 6, 1), 20);
    const bases = await this.visible(opts.agent, opts.kb);
    const hits: KbHit[] = [];
    let note: string | undefined;
    for (const kb of bases) {
      const loaded = await this.load(kb.id);
      if (!loaded.rows.length) continue;
      const lists: Scored[][] = [loaded.bm25.search(q, limit * 3)];
      if (kb.embedProvider && kb.embedModel && loaded.vectors.some(Boolean)) {
        try {
          const [qv] = await this.embed(kb.embedProvider, kb.embedModel, [q]);
          if (qv) lists.push(topBySimilarity(decodeVector(encodeVector(qv)), loaded.vectors, limit * 3));
        } catch (e) {
          note = `Semantic search was unavailable (${(e as Error).message.slice(0, 80)}); showing keyword matches.`;
        }
      }
      for (const s of fuseRanks(lists, limit)) {
        const r = loaded.rows[s.idx]!;
        hits.push({ kb: kb.name, docId: r.docId, docTitle: r.docTitle, source: r.source, chunk: r.idx, heading: r.heading, text: r.text, score: s.score });
      }
    }
    return { hits: hits.sort((a, b) => b.score - a.score).slice(0, limit), note };
  }

  /** The bases an agent may use (a base with no agents listed is for everyone). */
  private async visible(agent?: string, only?: string) {
    const rows = await this.prisma.knowledgeBase.findMany({ orderBy: { name: 'asc' } });
    return rows.filter((r) => {
      const agents = Array.isArray(r.agents) ? (r.agents as unknown[]).map(String) : [];
      if (only && r.name !== only && r.id !== only) return false;
      return !agent || agents.length === 0 || agents.includes(agent);
    });
  }

  // -------------------------------------------------------- agent tools

  /** `kb_list` — what the agent can search. */
  async listReport(agent?: string): Promise<string> {
    const rows = await this.visible(agent);
    if (!rows.length) return 'There are no knowledge bases for you.';
    const infos = await Promise.all(rows.map((r) => this.toInfo(r)));
    return infos
      .map((k) => `- ${k.name} — ${k.description || 'no description'} (${k.docs} documents, ${k.chunks} passages${k.embedProvider ? ', semantic search on' : ''}${k.agentWrite ? ', you may add notes with kb_add' : ''})`)
      .join('\n');
  }

  /** `kb_search` — ranked passages with where to read more. */
  async searchReport(input: { query?: string; kb?: string; limit?: number }, agent?: string): Promise<string> {
    const { hits, note } = await this.search(String(input.query ?? ''), { kb: input.kb, agent, limit: input.limit });
    if (!hits.length) return `Nothing found for "${input.query}" in your knowledge bases${note ? `. ${note}` : ''}. Try other words, or kb_list to see what exists.`;
    const lines = hits.map((h, i) => {
      const where = [h.docTitle, h.heading].filter(Boolean).join(' — ');
      const text = h.text.length > 700 ? `${h.text.slice(0, 700)}…` : h.text;
      return `${i + 1}. [${h.kb} · doc ${h.docId} · passage ${h.chunk}] ${where}${h.source ? ` (source: ${h.source})` : ''}\n${text}`;
    });
    return `${hits.length} passage(s) for "${input.query}":\n\n${lines.join('\n\n')}\n\nRead a whole passage (or its neighbours) with kb_read {doc, chunk}. Cite the source when you rely on a passage.${note ? `\n${note}` : ''}`;
  }

  /** `kb_read` — a whole passage, or the outline of a document. */
  async readReport(input: { doc?: string; chunk?: number }, agent?: string): Promise<string> {
    const d = await this.prisma.knowledgeDoc.findUnique({ where: { id: String(input.doc ?? '') }, include: { kb: true } });
    if (!d) return 'No such document. Use kb_search to find ids.';
    const allowed = (await this.visible(agent)).some((k) => k.id === d.kbId);
    if (!allowed) return 'No such document. Use kb_search to find ids.';
    const chunks = await this.prisma.knowledgeChunk.findMany({ where: { docId: d.id }, orderBy: { idx: 'asc' }, select: { idx: true, heading: true, text: true } });
    const head = `${d.title}${d.source ? ` (source: ${d.source})` : ''} — ${chunks.length} passage(s)`;
    if (input.chunk === undefined || input.chunk === null) {
      return `${head}\n${chunks.map((c) => `#${c.idx} ${c.heading ? `${c.heading}: ` : ''}${c.text.replace(/\s+/g, ' ').slice(0, 90)}…`).join('\n')}\n\nRead one with kb_read {doc, chunk}.`;
    }
    const c = chunks.find((x) => x.idx === Number(input.chunk));
    if (!c) return `${head}\nThere is no passage #${input.chunk}.`;
    return `${head}\n[passage ${c.idx}${c.heading ? ` — ${c.heading}` : ''}]\n${c.text}\n\n${c.idx > 0 ? `previous: kb_read {doc:"${d.id}", chunk:${c.idx - 1}}  ` : ''}${c.idx < chunks.length - 1 ? `next: kb_read {doc:"${d.id}", chunk:${c.idx + 1}}` : ''}`.trimEnd();
  }

  /** `kb_add` — an agent adds a note, only to a base that allows it. */
  async addReport(input: { kb?: string; title?: string; text?: string; source?: string }, agent?: string): Promise<string> {
    const bases = await this.visible(agent, String(input.kb ?? ''));
    const kb = bases[0];
    if (!kb) return `There is no knowledge base "${input.kb}" for you. Use kb_list.`;
    if (!kb.agentWrite) return `The base "${kb.name}" is read-only for agents (a person can switch on "agents may add notes" in the dashboard).`;
    const r = await this.addDocument(kb.name, { title: input.title, text: String(input.text ?? ''), source: input.source ?? `agent:${agent ?? 'agent'}`, kind: 'note' });
    return r.duplicate ? 'That text is already in the base.' : `Added "${input.title ?? 'note'}" to ${kb.name} (${r.chunks} passage(s)).`;
  }

  /** The line block for an agent's system prompt ('' = no bases for it). */
  async promptBlock(agent?: string): Promise<string> {
    const rows = await this.visible(agent);
    if (!rows.length) return '';
    const infos = await Promise.all(rows.map((r) => this.toInfo(r)));
    const lines = infos.filter((k) => k.chunks > 0).map((k) => `- ${k.name}: ${k.description || 'no description'} (${k.docs} documents)`);
    if (!lines.length) return '';
    return `\n\n## Knowledge bases\nSearch these with kb_search {query} (and read more with kb_read); they hold reference material that is too big for the prompt. Prefer them over guessing, and cite the source.\n${lines.join('\n')}`;
  }
}
