import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';

/** A named agent definition loaded from <agentDir>/agents/<name>.md. */
export interface AgentDef {
  name: string;
  description: string;
  /** Provider name this agent runs on; falls back to the default provider. */
  provider?: string;
  /** Provider names to fail over to (in order) if the primary run errors. */
  fallbackProviders?: string[];
  /** Model to use; falls back to the provider's default model when absent. */
  model?: string;
  /** Optional skill filenames to include; when absent, all skills are used. */
  skills?: string[];
  /** Tool allow/deny lists (e.g. a read-only reviewer). */
  allowedTools?: string[];
  disallowedTools?: string[];
  /** MCP server names this agent connects to (from the MCP registry). */
  mcp?: string[];
  /** The agent's system-prompt body. */
  instructions: string;
}

/** Public (list) shape — without the full instructions body. */
export type AgentSummary = Omit<AgentDef, 'instructions'>;

const NAME_RE = /^[\w-]+$/;

/**
 * File-based registry of named agents. Each ./agent/agents/<name>.md has YAML-ish
 * frontmatter (description, tier, skills) and a markdown body used as the agent's
 * system prompt. Read on demand so dropping a file needs no restart.
 */
@Injectable()
export class AgentRegistryService {
  private readonly logger = new Logger(AgentRegistryService.name);

  constructor(private readonly config: AppConfigService) {}

  private get dir(): string {
    return join(this.config.agentDir, 'agents');
  }

  /**
   * Skill names (basename without .md) available under <agentDir>/skills,
   * searched recursively so the core/ + learned/ split is picked up. README.md
   * files are excluded. Names are deduped — agents reference skills by bare name.
   */
  async listSkills(): Promise<string[]> {
    try {
      const entries = await readdir(join(this.config.agentDir, 'skills'), { recursive: true });
      const names = entries
        .filter((f) => f.endsWith('.md') && basename(f).toLowerCase() !== 'readme.md')
        .map((f) => basename(f).replace(/\.md$/, ''));
      return Array.from(new Set(names)).sort();
    } catch {
      return []; // no skills directory yet
    }
  }

  async list(): Promise<AgentSummary[]> {
    let files: string[];
    try {
      files = (await readdir(this.dir)).filter(
        (f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md',
      );
    } catch {
      return []; // no agents directory yet
    }
    const defs = await Promise.all(
      files.sort().map((f) => this.parseFile(f).catch(() => null)),
    );
    return defs
      .filter((d): d is AgentDef => d !== null)
      .map(
        ({ name, description, provider, fallbackProviders, model, skills, allowedTools, disallowedTools, mcp }) => ({
          name,
          description,
          provider,
          fallbackProviders,
          model,
          skills,
          allowedTools,
          disallowedTools,
          mcp,
        }),
      );
  }

  /** Load a single agent by name; throws 404 if missing. */
  async get(name: string): Promise<AgentDef> {
    if (!NAME_RE.test(name)) throw new NotFoundException(`Invalid agent name: ${name}`);
    try {
      return await this.parseFile(`${name}.md`);
    } catch {
      throw new NotFoundException(`Agent not found: ${name}`);
    }
  }

  /** Create or overwrite an agent's <name>.md file. */
  async save(
    name: string,
    def: {
      description?: string;
      provider?: string;
      fallbackProviders?: string[];
      model?: string;
      skills?: string[];
      allowedTools?: string[];
      disallowedTools?: string[];
      mcp?: string[];
      instructions: string;
    },
  ): Promise<AgentDef> {
    if (!NAME_RE.test(name)) {
      throw new BadRequestException('Agent name must be alphanumeric/dash/underscore');
    }
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, `${name}.md`), serializeAgent(def));
    this.logger.log(`Saved agent ${name}`);
    return this.get(name);
  }

  /** Delete an agent file. */
  async remove(name: string): Promise<void> {
    if (!NAME_RE.test(name)) throw new NotFoundException(`Agent not found: ${name}`);
    try {
      await unlink(join(this.dir, `${name}.md`));
    } catch {
      throw new NotFoundException(`Agent not found: ${name}`);
    }
    this.logger.log(`Deleted agent ${name}`);
  }

  private async parseFile(filename: string): Promise<AgentDef> {
    const raw = await readFile(join(this.dir, filename), 'utf8');
    const fallbackName = filename.replace(/\.md$/, '');
    const meta: Record<string, string> = {};
    let body = raw;

    const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (fm) {
      body = fm[2] ?? '';
      for (const rawLine of (fm[1] ?? '').split(/\r?\n/)) {
        const line = rawLine.trim();
        // Skip blanks and full-line comments; tolerate CRLF and quoted values.
        if (!line || line.startsWith('#')) continue;
        const idx = line.indexOf(':');
        if (idx === -1) continue;
        const key = line.slice(0, idx).trim();
        if (!key) continue;
        meta[key] = unquote(line.slice(idx + 1).trim());
      }
    }

    return {
      name: meta.name || fallbackName,
      description: meta.description || '',
      provider: meta.provider || undefined,
      fallbackProviders: csv(meta.fallbackProviders),
      model: meta.model || undefined,
      skills: csv(meta.skills),
      allowedTools: csv(meta.allowedTools),
      disallowedTools: csv(meta.disallowedTools),
      mcp: csv(meta.mcp),
      instructions: body.trim(),
    };
  }
}

/** Strip a single pair of surrounding single/double quotes, if present. */
function unquote(value: string): string {
  if (value.length >= 2) {
    const q = value[0];
    if ((q === '"' || q === "'") && value[value.length - 1] === q) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/** Parse a comma-separated frontmatter value into a list (or undefined). */
function csv(value?: string): string[] | undefined {
  if (!value) return undefined;
  // Tolerate a YAML flow sequence (`[a, b]`) as well as bare csv (`a, b`),
  // and strip quotes around individual items.
  const inner = value.trim().replace(/^\[/, '').replace(/\]$/, '');
  const list = inner
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
  return list.length ? list : undefined;
}

/** Build the <name>.md content from an agent definition. */
function serializeAgent(def: {
  description?: string;
  provider?: string;
  fallbackProviders?: string[];
  model?: string;
  skills?: string[];
  allowedTools?: string[];
  disallowedTools?: string[];
  mcp?: string[];
  instructions: string;
}): string {
  const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();
  const csvLine = (k: string, v?: string[]) =>
    v?.length ? `${k}: ${v.map((s) => s.trim()).join(', ')}` : null;
  const fm = [
    def.description ? `description: ${oneLine(def.description)}` : null,
    def.provider ? `provider: ${oneLine(def.provider)}` : null,
    csvLine('fallbackProviders', def.fallbackProviders),
    def.model ? `model: ${oneLine(def.model)}` : null,
    csvLine('skills', def.skills),
    csvLine('allowedTools', def.allowedTools),
    csvLine('disallowedTools', def.disallowedTools),
    csvLine('mcp', def.mcp),
  ].filter(Boolean);
  return `---\n${fm.join('\n')}\n---\n${def.instructions.trim()}\n`;
}
