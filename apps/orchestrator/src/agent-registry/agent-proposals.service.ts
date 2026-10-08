import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { PROPOSE_AGENT_TOOL, PROPOSE_SKILL_TOOL } from '@lds/shared';
import { AppConfigService } from '../config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { AdminAuditService } from './admin-audit.service';
import { isBuiltinAgent, parseAgentMarkdown } from './agent-registry.service';

const MAX_AGENT_BYTES = 20 * 1024;
const MAX_SKILL_BYTES = 16 * 1024;
const NAME_MAX = 60;
// Same charset as the Agents API (\w + dash) so agents created in the UI can be edited here too.
const AGENT_NAME_RE = /^[\w-]+$/;
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const RESERVED_NAMES = ['readme'];
/** Custom (user/admin-made) skills live under core/custom — a protected path for agents, untouched by the shipped-skills sync. */
const CUSTOM_SKILLS_SUBDIR = join('skills', 'core', 'custom');

/**
 * Set ONLY by PlatformAdminService.proposeBatch after a human approved the whole batch: inside it, the individual
 * proposals skip their own approval (the batch card was the approval) but still validate, apply and journal as usual.
 */
export const batchScope = new AsyncLocalStorage<{ approved: true }>();

export type ProposalResult = { ok: boolean; message: string };
type Result = ProposalResult;

/**
 * Write side of the admin agent: `propose_agent` / `propose_skill`. The PreToolUse
 * hook has ALREADY opened an approval (with the full content) before these run,
 * so the normal path just verifies that an approved request for this exact
 * content exists — no second prompt. If none is found (e.g. the call was
 * pre-approved by an exception, which leaves no row) we fall back to a real
 * approval check, so the write is fail-closed either way.
 *
 * ApprovalsService is resolved lazily (see SkillsLearnedService for why).
 */
@Injectable()
export class AgentProposalsService {
  private readonly logger = new Logger(AgentProposalsService.name);
  private approvalsCache?: ApprovalsService;

  constructor(
    private readonly config: AppConfigService,
    private readonly prisma: PrismaService,
    private readonly moduleRef: ModuleRef,
    private readonly audit: AdminAuditService,
  ) {}

  private get approvals(): ApprovalsService {
    if (!this.approvalsCache) this.approvalsCache = this.moduleRef.get(ApprovalsService, { strict: false });
    return this.approvalsCache;
  }

  /** Why this agent proposal can't be accepted (null = fine). Pure checks, no approval involved. */
  validateAgent(name: string, content: string): string | null {
    if (!AGENT_NAME_RE.test(name) || name.length > NAME_MAX || RESERVED_NAMES.includes(name.toLowerCase())) {
      return `agent name "${name}" must be letters, digits, dash or underscore (max ${NAME_MAX}).`;
    }
    if (isBuiltinAgent(name)) return `"${name}" is a built-in agent and cannot be overwritten.`;
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_AGENT_BYTES) return `${bytes} bytes exceeds the ${MAX_AGENT_BYTES}-byte limit — shorten the prompt.`;
    const parsed = parseAgentMarkdown(content, name);
    if (!parsed.instructions) return 'the agent has no system-prompt body after the frontmatter.';
    // A `name:` line in the frontmatter must not differ from the file name: the file
    // name is the identity, and a mismatch is how an agent would pass itself off as a built-in.
    if (parsed.name !== name || isBuiltinAgent(parsed.name)) {
      return 'remove the `name:` line from the frontmatter (the agent name is the `name` argument).';
    }
    if (parsed.mode) return 'remove the `mode:` line — chat mode is reserved for built-in agents (it runs outside the project, in the platform config dir).';
    if (!parsed.description) return 'add a one-line `description:` to the frontmatter.';
    return null;
  }

  /** Why this skill proposal can't be accepted (null = fine). */
  async validateSkill(name: string, content: string): Promise<string | null> {
    if (!SKILL_NAME_RE.test(name) || name.length > NAME_MAX || RESERVED_NAMES.includes(name)) {
      return `skill name "${name}" must be lowercase-with-hyphens (no path separators, dots, or extension, max ${NAME_MAX}).`;
    }
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_SKILL_BYTES) return `${bytes} bytes exceeds the ${MAX_SKILL_BYTES}-byte limit.`;
    if (!content.trim()) return 'empty skill.';
    // Skills are resolved by bare name, so a custom skill must not shadow a shipped/learned one.
    if (await this.shadowsExistingSkill(name)) return `a skill named "${name}" already exists — pick a different name.`;
    return null;
  }

  async proposeAgent(taskId: string, sessionId: string, name: string, content: string): Promise<Result> {
    const why = this.validateAgent(name, content);
    if (why) return { ok: false, message: `Rejected: ${why}` };
    return this.gatedWrite(taskId, sessionId, PROPOSE_AGENT_TOOL, name, content, join(this.config.agentDir, 'agents', `${name}.md`), 'agent');
  }

  async proposeSkill(taskId: string, sessionId: string, name: string, content: string): Promise<Result> {
    const why = await this.validateSkill(name, content);
    if (why) return { ok: false, message: `Rejected: ${why}` };
    return this.gatedWrite(taskId, sessionId, PROPOSE_SKILL_TOOL, name, content, join(this.config.agentDir, CUSTOM_SKILLS_SUBDIR, `${name}.md`), 'skill');
  }

  /** True if a non-custom skill (core/learned) already uses this bare name. */
  private async shadowsExistingSkill(name: string): Promise<boolean> {
    const entries = await readdir(join(this.config.agentDir, 'skills'), { recursive: true }).catch(() => []);
    return entries.some((f) => {
      const norm = f.split('\\').join('/');
      return norm.endsWith('.md') && basename(norm, '.md') === name && !norm.startsWith('core/custom/');
    });
  }

  private async gatedWrite(
    taskId: string,
    sessionId: string,
    toolName: string,
    name: string,
    content: string,
    path: string,
    kind: 'agent' | 'skill',
  ): Promise<Result> {
    const denied = await this.requireApproval(taskId, sessionId, toolName, { name, content }, (i) => i.name === name && i.content === content);
    if (denied) return denied;

    const snapshot = await this.snapshotIfExists(name, path, kind);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
    await this.audit.record({ taskId, tool: toolName.split('__').pop() ?? toolName, summary: `${snapshot ? 'Updated' : 'Created'} ${kind} "${name}"`, undo: { kind, name, snapshot } });
    this.logger.log(`Wrote ${kind} "${name}" (${Buffer.byteLength(content, 'utf8')} bytes)`);
    const where = kind === 'agent' ? `agent/agents/${name}.md` : `agent/${CUSTOM_SKILLS_SUBDIR}/${name}.md`;
    return { ok: true, message: `Approved and written to ${where}.` };
  }

  /**
   * Fail-closed approval gate shared by every admin write. The PreToolUse hook has already
   * opened an approval carrying the model's raw tool input; `match` verifies a human approved
   * THIS exact request (same task, same tool, matching content). When none is found (e.g. a
   * pre-approving exception leaves no row) we fall back to a real approval check here.
   * Returns null when approved, otherwise the rejection result to hand back to the agent.
   */
  async requireApproval(
    taskId: string,
    sessionId: string,
    toolName: string,
    toolInput: Record<string, unknown>,
    match: (input: Record<string, unknown>) => boolean,
  ): Promise<Result | null> {
    if (batchScope.getStore()?.approved) return null;
    if (await this.hasApproval(taskId, toolName, match)) return null;
    const approval = await this.approvals.check({ taskId, agentSessionId: sessionId, toolName, toolInput });
    let status: string;
    if (approval.allow) {
      status = 'approved';
    } else if (!approval.approvalId) {
      return { ok: false, message: `Denied: ${approval.reason}` };
    } else {
      status = (await this.approvals.waitForVerdict(approval.approvalId)).status;
    }
    if (status === 'approved') return null;
    return {
      ok: false,
      message:
        status === 'timeout'
          ? 'Denied: no human responded before the approval timed out (fail-closed). Nothing was changed.'
          : 'Denied: a human rejected this change. Nothing was changed.',
    };
  }

  /** True when a human already approved a request matching `match` for this task (the hook's approval). */
  private async hasApproval(taskId: string, toolName: string, match: (input: Record<string, unknown>) => boolean): Promise<boolean> {
    const rows = await this.prisma.approvalRequest.findMany({
      where: { taskId, toolName, status: 'approved' },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });
    return rows.some((r) => {
      const input = r.toolInput;
      return input !== null && typeof input === 'object' && !Array.isArray(input) && match(input as Record<string, unknown>);
    });
  }

  private async snapshotIfExists(name: string, path: string, kind: 'agent' | 'skill'): Promise<string | null> {
    const current = await readFile(path, 'utf8').catch(() => null);
    if (current === null) return null;
    const dir = join(this.config.agentDir, '.snapshots', kind === 'agent' ? 'agents' : 'skills');
    await mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = join(dir, `${name}.${stamp}.md`);
    await writeFile(file, current);
    return file;
  }
}
