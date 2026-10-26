import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { AgentRegistryService, NAME_RE, parseAgentMarkdown } from './agent-registry.service';
import { type AgentBundle, type BundleSkill, type PlanItem, planImport, validateBundle } from './agent-bundle';

const LEARNED_TOTAL_BYTES = 64_000;

/** Export / import of one agent together with its custom and learned skills — to move it to another Aigentron. */
@Injectable()
export class AgentBundleService {
  private readonly logger = new Logger(AgentBundleService.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly registry: AgentRegistryService,
  ) {}

  private skillsDir(...p: string[]): string {
    return join(this.config.agentDir, 'skills', ...p);
  }

  private async readSafe(path: string): Promise<string | null> {
    return readFile(path, 'utf8').catch(() => null);
  }

  private async names(dir: string): Promise<string[]> {
    const e = await readdir(dir, { withFileTypes: true }).catch(() => []);
    return e.filter((d) => d.isFile() && d.name.endsWith('.md') && d.name.toLowerCase() !== 'readme.md').map((d) => d.name.replace(/\.md$/, ''));
  }

  /** Skills that could travel with the agent: the ones it lists come along automatically, the other learned ones are the person's choice. */
  async candidates(name: string) {
    const agent = await this.registry.get(name);
    const listed = new Set(agent.skills ?? []);
    const custom = await this.names(this.skillsDir('core', 'custom'));
    const learned = await this.names(this.skillsDir('learned'));
    const size = async (p: string) => (await stat(p).catch(() => null))?.size ?? 0;
    return {
      custom: await Promise.all(custom.map(async (n) => ({ name: n, listed: listed.has(n), bytes: await size(this.skillsDir('core', 'custom', `${n}.md`)) }))),
      learned: await Promise.all(learned.map(async (n) => ({ name: n, listed: listed.has(n), bytes: await size(this.skillsDir('learned', `${n}.md`)) }))),
    };
  }

  async export(name: string, extraLearned: string[] = [], extraCustom: string[] = []): Promise<AgentBundle> {
    const agent = await this.registry.get(name);
    const content = await this.readSafe(join(this.config.agentDir, 'agents', `${name}.md`));
    if (content === null) throw new NotFoundException(`Agent not found: ${name}`);
    const listed = new Set(agent.skills ?? []);
    const skills: BundleSkill[] = [];
    for (const [kind, dir, extra] of [
      ['custom', this.skillsDir('core', 'custom'), extraCustom],
      ['learned', this.skillsDir('learned'), extraLearned],
    ] as const) {
      for (const n of await this.names(dir)) {
        if (!listed.has(n) && !extra.includes(n)) continue;
        const c = await this.readSafe(join(dir, `${n}.md`));
        if (c !== null) skills.push({ name: n, kind, content: c });
      }
    }
    return { format: 'aigentron-agent', version: 1, exportedAt: new Date().toISOString(), agent: { name, content }, skills };
  }

  private async current(bundle: AgentBundle, agentName: string): Promise<{ existing: Map<string, string>; core: Set<string> }> {
    const existing = new Map<string, string>();
    const a = await this.readSafe(join(this.config.agentDir, 'agents', `${agentName}.md`));
    if (a !== null) existing.set(`agent:${agentName}`, a);
    for (const s of bundle.skills) {
      const dir = s.kind === 'custom' ? this.skillsDir('core', 'custom') : this.skillsDir('learned');
      const c = await this.readSafe(join(dir, `${s.name}.md`));
      if (c !== null) existing.set(`skill:${s.kind}:${s.name}`, c);
    }
    return { existing, core: new Set(await this.names(this.skillsDir('core'))) };
  }

  async importBundle(
    raw: unknown,
    opts: { agentName?: string; overwrite?: string[]; dryRun?: boolean },
  ): Promise<{ applied: boolean; plan: PlanItem[]; agent: { provider?: string; model?: string; mcp?: string[]; skills?: string[] }; warnings: string[] }> {
    const { bundle, errors } = validateBundle(raw);
    if (!bundle) throw new BadRequestException(errors.join(' '));
    const agentName = opts.agentName?.trim() || bundle.agent.name;
    if (!NAME_RE.test(agentName)) throw new BadRequestException(`Invalid agent name "${agentName}".`);
    const { existing, core } = await this.current(bundle, agentName);
    const plan = planImport(bundle, existing, core, { agentName, overwrite: opts.overwrite });
    const def = parseAgentMarkdown(bundle.agent.content, agentName);
    const warnings: string[] = [];
    if (def.createTasks) warnings.push('The agent asked for the right to start new tasks (createTasks) — not carried over; set it by hand if wanted.');
    const have = new Set([...(await this.registry.listSkills()), ...bundle.skills.map((s) => s.name)]);
    const missing = (def.skills ?? []).filter((s) => !have.has(s));
    if (missing.length) warnings.push(`Skills this agent lists are not on this server: ${missing.join(', ')}.`);
    if (def.provider) warnings.push(`It uses provider "${def.provider}"${def.model ? ` / ${def.model}` : ''} and MCP ${def.mcp?.join(', ') || 'none'} — check they exist here.`);
    const info = { provider: def.provider, model: def.model, mcp: def.mcp, skills: def.skills };
    if (opts.dryRun) return { applied: false, plan, agent: info, warnings };

    let learnedTotal = 0;
    for (const n of await this.names(this.skillsDir('learned'))) learnedTotal += (await stat(this.skillsDir('learned', `${n}.md`)).catch(() => null))?.size ?? 0;
    for (const item of plan) {
      if (!item.write) continue;
      if (item.kind === 'agent') {
        await this.registry.save(agentName, { ...def, createTasks: undefined, instructions: def.instructions });
        continue;
      }
      const s = bundle.skills.find((x) => x.kind === item.kind && x.name === item.name)!;
      const dir = s.kind === 'custom' ? this.skillsDir('core', 'custom') : this.skillsDir('learned');
      if (s.kind === 'learned') {
        const size = Buffer.byteLength(s.content, 'utf8');
        const old = existing.get(item.key);
        const after = learnedTotal - (old ? Buffer.byteLength(old, 'utf8') : 0) + size;
        if (after > LEARNED_TOTAL_BYTES) {
          item.write = false;
          item.status = 'blocked';
          item.note = `Over the learned-skills budget (${LEARNED_TOTAL_BYTES} bytes) — prune first.`;
          continue;
        }
        learnedTotal = after;
      }
      await mkdir(dir, { recursive: true });
      const old = existing.get(item.key);
      if (old !== undefined) {
        const snap = join(dir, '.snapshots');
        await mkdir(snap, { recursive: true });
        await writeFile(join(snap, `${s.name}.${new Date().toISOString().replace(/[:.]/g, '-')}.md`), old);
      }
      await writeFile(join(dir, `${s.name}.md`), s.content);
    }
    this.logger.log(`Imported agent bundle "${agentName}" (${plan.filter((i) => i.write).length} written)`);
    return { applied: true, plan, agent: info, warnings };
  }
}
