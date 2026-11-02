import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { ADMIN_REFERENCE_CHUNKING, ADMIN_REFERENCE_KB, buildReferenceIndex, splitGuide, type RefDoc } from './admin-reference-core';
import { KnowledgeService } from './knowledge.service';

/**
 * The administrator's reference as a knowledge base kept by the platform: the shipped guides (agent/skills/core/admin/*.md) are cut into sections and
 * synchronised into the read-only base `admin-reference` at every start (only what changed is touched). The administrator then keeps a table of contents
 * in its prompt instead of 45 KB of guides, and searches the base when it needs a passage.
 */
@Injectable()
export class AdminReferenceService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AdminReferenceService.name);
  private syncing: Promise<void> | null = null;
  private indexText: string | null = null;

  constructor(
    private readonly config: AppConfigService,
    private readonly knowledge: KnowledgeService,
  ) {}

  onApplicationBootstrap(): void {
    // never holds the start-up: a failure leaves the administrator on the inlined guides
    void this.sync().catch((e) => this.logger.warn(`the administrator's reference could not be synchronised: ${(e as Error).message}`));
  }

  /** The shipped guides as documents (empty when the directory is missing). */
  async load(): Promise<RefDoc[]> {
    // the release's own copy first (the live copy in the agent directory is only refreshed by another start-up task, so after an update it may still be the old one)
    let dir = join(this.config.shippedAgentDir, 'skills', 'core', 'admin');
    let files = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith('.md')).sort();
    if (!files.length) {
      dir = join(this.config.agentDir, 'skills', 'core', 'admin');
      files = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith('.md')).sort();
    }
    const docs: RefDoc[] = [];
    for (const f of files) docs.push(...splitGuide(f, await readFile(join(dir, f), 'utf8')));
    return docs;
  }

  /** Bring the base in line with the shipped files; concurrent calls share one run. */
  sync(): Promise<void> {
    return (this.syncing ??= (async () => {
      const docs = await this.load();
      if (!docs.length) {
        this.logger.warn('no administrator guides found — the reference base is left as it is');
        return;
      }
      const r = await this.knowledge.syncSystemBase(
        { name: ADMIN_REFERENCE_KB, description: "The administrator's reference: the guides to the tools, the dashboard, the settings, agents and tasks. Read-only.", agents: ['admin'], chunking: ADMIN_REFERENCE_CHUNKING },
        docs,
      );
      this.indexText = buildReferenceIndex(docs.map((d) => d.title));
      this.logger.log(`administrator reference: ${r.added} added, ${r.removed} removed, ${r.kept} unchanged (${docs.length} sections)`);
    })().finally(() => (this.syncing = null)));
  }

  /**
   * The passages of the guides that best match a message, whole, ready to be attached to the administrator's message (one turn instead of a search
   * and a read). Empty when nothing matches or the base is not ready. About 1.5k tokens at most.
   */
  async relevant(query: string, limit = 4): Promise<string> {
    const q = query.replace(/\s+/g, ' ').trim().slice(0, 400);
    if (!q) return '';
    const { hits } = await this.knowledge.search(q, { kb: ADMIN_REFERENCE_KB, agent: 'admin', limit }).catch(() => ({ hits: [] as { docTitle: string; heading: string; text: string }[] }));
    const out: string[] = [];
    let used = 0;
    for (const h of hits) {
      if (used + h.text.length > 6500) break;
      used += h.text.length;
      out.push(`### ${h.docTitle}${h.heading && !h.docTitle.includes(h.heading.slice(0, 20)) ? ` — ${h.heading}` : ''}\n${h.text}`);
    }
    return out.length ? `## Passages from your reference (they match this message — answer from them)\n\n${out.join('\n\n')}` : '';
  }

  /**
   * The table of contents for the administrator's prompt, or null when the base is not ready (then its guides are inlined as before). Waits for a
   * synchronisation that is running right now; the text is the same on every run until the guides change (the prompt cache depends on it).
   */
  async index(): Promise<string | null> {
    if (this.syncing) await this.syncing.catch(() => undefined);
    if (this.indexText) return this.indexText;
    const titles = await this.knowledge.documentTitles(ADMIN_REFERENCE_KB).catch(() => []);
    if (!titles.length) return null;
    return (this.indexText = buildReferenceIndex(titles));
  }
}
