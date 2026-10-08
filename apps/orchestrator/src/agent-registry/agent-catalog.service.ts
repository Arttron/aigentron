import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Injectable, NotFoundException } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { AgentDef, AgentSummary, parseAgentMarkdown } from './agent-registry.service';

const NAME_RE = /^[\w-]+$/;

/** A catalog entry: the template summary plus its raw .md (what the admin agent copies from). */
export interface CatalogEntry extends AgentSummary {
  /** Full file content, ready to be tailored and proposed as a new agent. */
  content: string;
}

/**
 * Read-only catalog of agent TEMPLATES shipped with the release
 * (`<shippedAgentDir>/catalog/agents/*.md`). Templates are not live agents —
 * the admin agent reads them and proposes tailored copies into
 * `<agentDir>/agents/`. Read from the shipped dir on every call, so a new
 * release's templates show up without any sync step.
 */
@Injectable()
export class AgentCatalogService {
  constructor(private readonly config: AppConfigService) {}

  private get dir(): string {
    return join(this.config.shippedAgentDir, 'catalog', 'agents');
  }

  async list(): Promise<AgentSummary[]> {
    let files: string[];
    try {
      files = (await readdir(this.dir)).filter(
        (f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md',
      );
    } catch {
      return [];
    }
    const defs = await Promise.all(files.sort().map((f) => this.load(f).catch(() => null)));
    return defs
      .filter((d): d is CatalogEntry => d !== null)
      .map(({ content: _content, ...summary }) => summary);
  }

  async get(name: string): Promise<CatalogEntry> {
    if (!NAME_RE.test(name)) throw new NotFoundException(`Template not found: ${name}`);
    try {
      return await this.load(`${name}.md`);
    } catch {
      throw new NotFoundException(`Template not found: ${name}`);
    }
  }

  /** A template as an editable definition (what the "+ New agent" form pre-fills). */
  async getDef(name: string): Promise<AgentDef> {
    const entry = await this.get(name);
    return parseAgentMarkdown(entry.content, name);
  }

  private async load(filename: string): Promise<CatalogEntry> {
    const content = await readFile(join(this.dir, filename), 'utf8');
    const def: AgentDef = parseAgentMarkdown(content, filename.replace(/\.md$/, ''));
    const { instructions: _instructions, ...summary } = def;
    return { ...summary, content };
  }
}
