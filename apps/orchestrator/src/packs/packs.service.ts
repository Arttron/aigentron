import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { AppConfigService } from '../config/app-config.service';
import { AgentRegistryService, parseAgentMarkdown } from '../agent-registry/agent-registry.service';
import { AgentCatalogService } from '../agent-registry/agent-catalog.service';
import { ResourcesService } from '../resources/resources.service';
import { isValidTimezone } from '../schedules/schedule-core';

export interface PackManifest {
  title: string;
  icon?: string;
  description: string;
  audience?: string;
  /** Agent files shipped inside the pack (agents/<name>.md). */
  agents?: string[];
  /** Agents copied from the shared catalog of templates. */
  catalogAgents?: string[];
  skills?: string[];
  resources?: { file: string; title: string; description?: string; tags?: string[]; agents?: string[] }[];
  /** Always created SWITCHED OFF (a person picks the chat and turns them on). Task kind only. */
  schedules?: { name: string; cron: string; kind: 'task'; agent: string; text: string; quietStart?: string; quietEnd?: string }[];
  /** What to do after installing — shown to the person and handed to the admin. */
  after?: string;
}

export interface PackInfo extends PackManifest {
  name: string;
  /** How much of the pack is already here. */
  installed: { agents: number; skills: number; resources: number; schedules: number };
  total: { agents: number; skills: number; resources: number; schedules: number };
}

export interface InstallReport {
  pack: string;
  added: { agents: string[]; skills: string[]; resources: string[]; schedules: string[] };
  /** Already present — left exactly as they were (a pack never overwrites your changes). */
  skipped: string[];
  problems: string[];
  after?: string;
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

/**
 * Content packs: ready-made sets of agents, skills, starter resources and (switched-off) schedules for a kind of project —
 * shipped with the release in `<shipped agent dir>/packs/<name>/`. Installing never overwrites anything that already exists.
 */
@Injectable()
export class PacksService {
  private readonly logger = new Logger(PacksService.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly moduleRef: ModuleRef,
    private readonly agents: AgentRegistryService,
    private readonly catalog: AgentCatalogService,
    private readonly resources: ResourcesService,
  ) {}

  private get dir(): string {
    return join(this.config.shippedAgentDir, 'packs');
  }

  private async manifest(name: string): Promise<PackManifest> {
    if (!NAME_RE.test(name)) throw new NotFoundException(`Pack not found: ${name}`);
    try {
      return JSON.parse(await readFile(join(this.dir, name, 'pack.json'), 'utf8')) as PackManifest;
    } catch {
      throw new NotFoundException(`Pack not found: ${name}`);
    }
  }

  private totals(m: PackManifest) {
    return {
      agents: (m.agents?.length ?? 0) + (m.catalogAgents?.length ?? 0),
      skills: m.skills?.length ?? 0,
      resources: m.resources?.length ?? 0,
      schedules: m.schedules?.length ?? 0,
    };
  }

  async list(): Promise<PackInfo[]> {
    let names: string[] = [];
    try {
      names = (await readdir(this.dir)).filter((n) => NAME_RE.test(n)).sort();
    } catch {
      return [];
    }
    const out: PackInfo[] = [];
    for (const name of names) {
      try {
        out.push(await this.info(name));
      } catch {
        /* a broken pack must not hide the others */
      }
    }
    return out;
  }

  async info(name: string): Promise<PackInfo> {
    const m = await this.manifest(name);
    const have = new Set((await this.agents.list().catch(() => [])).map((a) => a.name));
    const allAgents = [...(m.agents ?? []), ...(m.catalogAgents ?? [])];
    const library = await this.resources.list();
    const schedulesSvc = await this.schedulesSvc();
    const existingSchedules = new Set((await schedulesSvc.list().catch(() => [])).map((s) => s.name));
    const skillExists = async (s: string) => !!(await stat(join(this.config.agentDir, 'skills', 'core', 'custom', `${s}.md`)).catch(() => null));
    let skills = 0;
    for (const s of m.skills ?? []) if (await skillExists(s)) skills++;
    return {
      ...m,
      name,
      total: this.totals(m),
      installed: {
        agents: allAgents.filter((a) => have.has(a)).length,
        skills,
        resources: (m.resources ?? []).filter((r) => library.some((x) => x.title === r.title && x.source === `pack:${name}`)).length,
        schedules: (m.schedules ?? []).filter((s) => existingSchedules.has(s.name)).length,
      },
    };
  }

  /** Loaded lazily: the scheduler pulls in the channel manager → approvals → the admin service, which uses packs. */
  private async schedulesSvc() {
    const { SchedulesService } = await import('../schedules/schedules.service');
    return this.moduleRef.get(SchedulesService, { strict: false });
  }

  async install(name: string, opts: { timezone?: string; by?: string } = {}): Promise<InstallReport> {
    const m = await this.manifest(name);
    const tz = opts.timezone && isValidTimezone(opts.timezone) ? opts.timezone : 'UTC';
    if (opts.timezone && tz === 'UTC' && opts.timezone !== 'UTC') throw new BadRequestException(`unknown time zone "${opts.timezone}".`);
    const report: InstallReport = { pack: name, added: { agents: [], skills: [], resources: [], schedules: [] }, skipped: [], problems: [], after: m.after };
    const packDir = join(this.dir, name);

    // agents shipped in the pack
    for (const a of m.agents ?? []) {
      try {
        if (await this.agents.get(a).catch(() => null)) {
          report.skipped.push(`agent ${a}`);
          continue;
        }
        const def = parseAgentMarkdown(await readFile(join(packDir, 'agents', `${a}.md`), 'utf8'), a);
        await this.agents.save(a, { ...def, instructions: def.instructions });
        report.added.agents.push(a);
      } catch (e) {
        report.problems.push(`agent ${a}: ${(e as Error).message}`);
      }
    }
    // agents copied from the catalog of templates
    for (const a of m.catalogAgents ?? []) {
      try {
        if (await this.agents.get(a).catch(() => null)) {
          report.skipped.push(`agent ${a}`);
          continue;
        }
        const def = await this.catalog.getDef(a);
        await this.agents.save(a, { ...def, instructions: def.instructions });
        report.added.agents.push(a);
      } catch (e) {
        report.problems.push(`agent ${a}: ${(e as Error).message}`);
      }
    }
    // skills → the custom skills folder (never over an existing file)
    for (const s of m.skills ?? []) {
      const dest = join(this.config.agentDir, 'skills', 'core', 'custom', `${s}.md`);
      if (await stat(dest).catch(() => null)) {
        report.skipped.push(`skill ${s}`);
        continue;
      }
      try {
        await mkdir(join(this.config.agentDir, 'skills', 'core', 'custom'), { recursive: true });
        await writeFile(dest, await readFile(join(packDir, 'skills', `${s}.md`), 'utf8'));
        report.added.skills.push(s);
      } catch (e) {
        report.problems.push(`skill ${s}: ${(e as Error).message}`);
      }
    }
    // starter resources
    for (const r of m.resources ?? []) {
      try {
        const added = await this.resources.addFromPath(join(packDir, r.file), { title: r.title, description: r.description, tags: r.tags, agents: r.agents, source: `pack:${name}` });
        if (added) report.added.resources.push(r.title);
        else report.skipped.push(`resource "${r.title}"`);
      } catch (e) {
        report.problems.push(`resource "${r.title}": ${(e as Error).message}`);
      }
    }
    // schedules — created switched OFF, no chat chosen; the person turns them on
    const schedules = await this.schedulesSvc();
    const existing = new Set((await schedules.list()).map((s) => s.name));
    for (const s of m.schedules ?? []) {
      if (existing.has(s.name)) {
        report.skipped.push(`schedule "${s.name}"`);
        continue;
      }
      try {
        await schedules.create({ name: s.name, cron: s.cron, timezone: tz, kind: s.kind, text: s.text, agentName: s.agent, quietStart: s.quietStart ?? null, quietEnd: s.quietEnd ?? null, enabled: false }, opts.by ?? `pack ${name}`);
        report.added.schedules.push(s.name);
      } catch (e) {
        report.problems.push(`schedule "${s.name}": ${(e as Error).message}`);
      }
    }
    this.logger.log(`Pack "${name}" installed: ${JSON.stringify({ added: report.added, skipped: report.skipped.length, problems: report.problems.length })}`);
    return report;
  }
}

/** Plain-words version of a report (for the dashboard and the admin). */
export function describeReport(r: InstallReport): string {
  const parts: string[] = [];
  const add = (label: string, list: string[]) => list.length && parts.push(`${label}: ${list.join(', ')}`);
  add('agents added', r.added.agents);
  add('skills added', r.added.skills);
  add('library items added', r.added.resources);
  add('schedules added (switched OFF)', r.added.schedules);
  if (r.skipped.length) parts.push(`already there, left untouched: ${r.skipped.join(', ')}`);
  if (r.problems.length) parts.push(`PROBLEMS: ${r.problems.join('; ')}`);
  return `${parts.join('\n') || 'Nothing to do — everything is already installed.'}${r.after ? `\n\nNext steps: ${r.after}` : ''}`;
}
