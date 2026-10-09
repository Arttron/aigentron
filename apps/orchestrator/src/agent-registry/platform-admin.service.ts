import { copyFile, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
  PROPOSE_AGENT_DELETE_TOOL,
  PROPOSE_AGENT_TOOL,
  PROPOSE_BATCH_TOOL,
  PROPOSE_CLEANUP_TOOL,
  PROPOSE_PROVIDER_TOOL,
  PROPOSE_SCHEDULE_TOOL,
  PROPOSE_ALLOWED_DOMAINS_TOOL,
  PROPOSE_CLOUDFLARE_ACCESS_TOOL,
  PROPOSE_CHANNEL_TOOL,
  PROPOSE_RESOURCE_TOOL,
  PROPOSE_PACK_INSTALL_TOOL,
  PROPOSE_SETTINGS_TOOL,
  PROPOSE_TASK_TOOL,
  PROPOSE_UNDO_TOOL,
  PROPOSE_SKILL_TOOL,
  PROPOSE_TASK_ACTION_TOOL,
  REQUEST_SECRET_TOOL,
} from '@lds/shared';
import { AppConfigService } from '../config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { TasksService } from '../tasks/tasks.service';
import { ProvidersService } from '../providers/providers.service';
import { SettingsService } from '../settings/settings.service';
import { MaintenanceService } from '../maintenance/maintenance.service';
import { StatsService } from '../stats/stats.service';
import { AdminAuditService, type AuditEntry } from './admin-audit.service';
import type { SchedulesService } from '../schedules/schedules.service';
import { ChannelsService } from '../channels/channels.service';
import { PairingService } from '../channels/pairing.service';
import { ResourcesService } from '../resources/resources.service';
import { cleanTags, validateMeta } from '../resources/resources-core';
import type { PacksService } from '../packs/packs.service';
import { describeSchedule } from '../schedules/schedule-core';
import { AccessService } from '../access/access.service';
import { parseDomainList } from '../access/access-core';
import { CloudflareAccessService } from '../access/cloudflare-access.service';
import { parseAud, parseTeamDomain } from '../access/cloudflare-access-core';
import { validateProviderProposal, validateSettingsChanges, type ProviderProposal } from './admin-validation';

export { validateProviderProposal, validateSettingsChanges };
export type { ProviderProposal };
import { AgentProposalsService, batchScope, type ProposalResult } from './agent-proposals.service';
import { AgentRegistryService, isBuiltinAgent } from './agent-registry.service';

const MAX_LIST = 200;
const DEFAULT_LIST = 50;
const STATUSES = ['queued', 'running', 'needs_approval', 'done', 'failed', 'cancelled', 'blocked', 'stalled'];

/**
 * Platform management for the admin agent. Reading is free (`tasks_list`); every mutation
 * (cancel/delete tasks, delete an agent) is a proposal that only runs after a human approves
 * the exact request on an approval card — same flow as `propose_agent`.
 *
 * TasksService is resolved lazily (module cycle: tasks → queue → agent executor → this service).
 */
export interface ResourceProposal {
  action: 'create' | 'update' | 'delete';
  id?: string;
  title?: string;
  description?: string;
  tags?: string[];
  agents?: string[];
  text?: string;
  reason: string;
}

export interface ChannelProposal {
  action: 'create' | 'update' | 'delete';
  name: string;
  kind?: string;
  enabled?: boolean;
  defaultAgent?: string;
  allowChatId?: string;
  removeChatId?: string;
  reason: string;
}

export interface DomainsProposal {
  action: 'add' | 'remove' | 'set' | 'clear';
  domains?: string[];
  reason: string;
}

export interface CloudflareProposal {
  enabled: boolean;
  teamDomain: string;
  aud?: string;
  reason: string;
}

export interface ScheduleProposal {
  action: 'create' | 'update' | 'delete';
  name: string;
  cron?: string;
  timezone?: string;
  kind?: 'message' | 'task';
  text?: string;
  agentName?: string;
  channel?: string;
  chatId?: string;
  quietStart?: string;
  quietEnd?: string;
  enabled?: boolean;
  reason: string;
}

@Injectable()
export class PlatformAdminService {
  private readonly logger = new Logger(PlatformAdminService.name);
  private tasksCache?: TasksService;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly moduleRef: ModuleRef,
    private readonly proposals: AgentProposalsService,
    private readonly agents: AgentRegistryService,
    private readonly audit: AdminAuditService,
  ) {}

  private schedulesCache?: SchedulesService;
  private channelsCache?: ChannelsService;
  private packsCache?: PacksService;
  /** Lazy + dynamic import: packs → scheduler → channel manager → approvals → this file. */
  private async packsSvc(): Promise<PacksService> {
    if (!this.packsCache) {
      const { PacksService: Cls } = await import('../packs/packs.service');
      this.packsCache = this.moduleRef.get(Cls, { strict: false });
    }
    return this.packsCache;
  }
  private resourcesCache?: ResourcesService;
  private get resources(): ResourcesService {
    if (!this.resourcesCache) this.resourcesCache = this.moduleRef.get(ResourcesService, { strict: false });
    return this.resourcesCache;
  }
  private pairingCache?: PairingService;
  private get pairing(): PairingService {
    if (!this.pairingCache) this.pairingCache = this.moduleRef.get(PairingService, { strict: false });
    return this.pairingCache;
  }
  /**
   * Loaded lazily with a dynamic import: SchedulesService pulls in the channel manager → approvals → this file, and a
   * static import closes that cycle at module-load time (Nest then sees an undefined provider).
   */
  private async schedulesSvc(): Promise<SchedulesService> {
    if (!this.schedulesCache) {
      const { SchedulesService: Cls } = await import('../schedules/schedules.service');
      this.schedulesCache = this.moduleRef.get(Cls, { strict: false });
    }
    return this.schedulesCache;
  }
  private get accessSvc(): AccessService {
    return this.moduleRef.get(AccessService, { strict: false });
  }
  private get cloudflareSvc(): CloudflareAccessService {
    return this.moduleRef.get(CloudflareAccessService, { strict: false });
  }
  private get channelsSvc(): ChannelsService {
    if (!this.channelsCache) this.channelsCache = this.moduleRef.get(ChannelsService, { strict: false });
    return this.channelsCache;
  }

  private get tasks(): TasksService {
    if (!this.tasksCache) this.tasksCache = this.moduleRef.get(TasksService, { strict: false });
    return this.tasksCache;
  }

  /**
   * Validate an admin proposal BEFORE any approval card is opened, so a human is never asked to
   * approve a request that is going to be rejected anyway (e.g. a model that invented task ids).
   * Returns the reason to hand back to the agent, or null when the request is well-formed.
   */
  async precheck(toolName: string, toolInput: Record<string, unknown>, currentTaskId: string, planned?: ReadonlySet<string>): Promise<string | null> {
    const str = (v: unknown) => (typeof v === 'string' ? v : '');
    if (toolName === PROPOSE_TASK_ACTION_TOOL) {
      const action = str(toolInput.action);
      const ids = Array.isArray(toolInput.taskIds) ? Array.from(new Set(toolInput.taskIds.map((x) => String(x).trim()).filter(Boolean))) : [];
      if (action !== 'cancel' && action !== 'delete') return 'Refused: action must be "cancel" or "delete".';
      if (!ids.length || ids.length > MAX_LIST) return `Refused: give between 1 and ${MAX_LIST} task ids.`;
      if (ids.includes(currentTaskId)) return "Refused: you can't act on this chat's own task — remove it from the list.";
      const found = new Set((await this.prisma.task.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((t) => t.id));
      const missing = ids.filter((id) => !found.has(id));
      if (missing.length) {
        return `Refused (no approval was requested): ${missing.length} of ${ids.length} task ids do not exist (e.g. ${missing.slice(0, 5).join(', ')}). Call tasks_list in this conversation and pass ONLY ids it returned.`;
      }
      return null;
    }
    if (toolName === PROPOSE_AGENT_DELETE_TOOL) {
      const name = str(toolInput.name).trim();
      if (isBuiltinAgent(name)) return `Refused: "${name}" is a built-in agent and cannot be deleted.`;
      if (!(await this.agents.get(name).catch(() => null))) return `Refused: no agent named "${name}". Use agents_list to see what exists.`;
      return null;
    }
    if (toolName === PROPOSE_BATCH_TOOL) {
      return this.validateBatch(toolInput.items, currentTaskId, str(toolInput.reason));
    }
    if (toolName === PROPOSE_TASK_TOOL) {
      const agent = str(toolInput.agentName).trim();
      const prompt = str(toolInput.prompt);
      if (!agent) return 'Refused: give the agent that should run the task.';
      if (isBuiltinAgent(agent)) return `Refused: "${agent}" is a built-in agent — pick another one (agents_list).`;
      if (!planned?.has(agent) && !(await this.agents.get(agent).catch(() => null))) return `Refused: no agent named "${agent}". Use agents_list.`;
      if (prompt.trim().length < 10 || prompt.length > 8000) return 'Refused: the prompt must be a real brief (10–8000 characters).';
      if (str(toolInput.title).length > 200) return 'Refused: the title is too long (max 200).';
      return null;
    }
    if (toolName === PROPOSE_SETTINGS_TOOL) {
      const why = validateSettingsChanges(toolInput.changes as Record<string, unknown> | undefined);
      if (why) return `Refused: ${why}`;
      const da = (toolInput.changes as Record<string, unknown>).defaultAgent;
      if (typeof da === 'string' && !planned?.has(da) && !(await this.agents.get(da).catch(() => null))) return `Refused: there is no agent named "${da}". Use agents_list.`;
      if (!str(toolInput.reason).trim()) return 'Refused: give a reason.';
      return null;
    }
    if (toolName === PROPOSE_UNDO_TOOL) {
      const e = await this.audit.get(str(toolInput.changeId).trim());
      if (!e) return `Refused: no change with id "${str(toolInput.changeId)}". Use admin_history.`;
      if (!e.undo) return `Refused: "${e.summary}" cannot be reverted (deleted tasks, cleanups and entered secrets can't be restored).`;
      if (e.undone) return `Refused: change ${e.id} was already reverted.`;
      if (e.undo.kind === 'agent_delete' && !e.undo.snapshot) return 'Refused: there is no snapshot to restore that agent from.';
      return null;
    }
    if (toolName === REQUEST_SECRET_TOOL) {
      const target = str(toolInput.target);
      if (target === 'github_token') return null;
      if (target === 'channel') {
        const cname = str(toolInput.name).trim();
        const ch = cname ? (await this.channelsSvc.list()).find((c) => c.name === cname) : undefined;
        return ch ? null : `Refused: no channel named "${cname}". Create it first (propose_channel) or check channels_list.`;
      }
      if (target !== 'provider') return 'Refused: target must be "provider", "github_token" or "channel".';
      const name = str(toolInput.name).trim();
      const row = name ? await this.providers.list().then((rows) => rows.find((r) => r.name === name)) : undefined;
      if (!row) return `Refused: no provider named "${name}". Create it first (propose_provider) or check providers_list.`;
      if (row.authMode === 'codex-login') return `Refused: "${name}" signs in with ChatGPT (no key) — the sign-in is done once on the server with \`codex login --device-auth\`.`;
      return null;
    }
    if (toolName === PROPOSE_CLEANUP_TOOL) {
      const days = toolInput.olderThanDays;
      if (days !== undefined && (typeof days !== 'number' || days < 1 || days > 3650)) return 'Refused: olderThanDays must be between 1 and 3650.';
      if (toolInput.runs === false && !toolInput.worktrees && !toolInput.deleteBranches) return 'Refused: select something to clean (runs, worktrees or deleteBranches).';
      if (toolInput.deleteBranches && !toolInput.worktrees) return 'Refused: deleteBranches applies to the branches of removed worktrees — set worktrees too.';
      return null;
    }
    if (toolName === PROPOSE_PACK_INSTALL_TOOL) {
      const why = await this.checkPack(str(toolInput.name), str(toolInput.timezone));
      return why ? `Refused: ${why}` : null;
    }
    if (toolName === PROPOSE_RESOURCE_TOOL) {
      const why = await this.checkResource(toolInput as unknown as ResourceProposal);
      return why ? `Refused: ${why}` : null;
    }
    if (toolName === PROPOSE_CHANNEL_TOOL) {
      const why = await this.checkChannel(toolInput as unknown as ChannelProposal);
      return why ? `Refused: ${why}` : null;
    }
    if (toolName === PROPOSE_SCHEDULE_TOOL) {
      const why = await this.checkSchedule(toolInput as unknown as ScheduleProposal);
      return why ? `Refused: ${why}` : null;
    }
    if (toolName === PROPOSE_ALLOWED_DOMAINS_TOOL) {
      const why = this.checkDomains(toolInput as unknown as DomainsProposal);
      return why ? `Refused: ${why}` : null;
    }
    if (toolName === PROPOSE_CLOUDFLARE_ACCESS_TOOL) {
      const why = await this.checkCloudflare(toolInput as unknown as CloudflareProposal);
      return why ? `Refused: ${why}` : null;
    }
    if (toolName === PROPOSE_PROVIDER_TOOL) {
      const why = validateProviderProposal(toolInput as Partial<ProviderProposal>);
      return why ? `Refused: ${why}` : null;
    }
    if (toolName === PROPOSE_AGENT_TOOL) {
      const why = this.proposals.validateAgent(str(toolInput.name), str(toolInput.content));
      return why ? `Refused: ${why}` : null;
    }
    if (toolName === PROPOSE_SKILL_TOOL) {
      const why = await this.proposals.validateSkill(str(toolInput.name), str(toolInput.content));
      return why ? `Refused: ${why}` : null;
    }
    return null;
  }

  async tasksList(input: { status?: string; limit?: number; order?: string; olderThanDays?: number }): Promise<string> {
    const status = input.status?.trim();
    if (status && !STATUSES.includes(status)) {
      return `Unknown status "${status}". Valid: ${STATUSES.join(', ')}.`;
    }
    const limit = Math.min(MAX_LIST, Math.max(1, Math.round(input.limit ?? DEFAULT_LIST)));
    const oldest = input.order === 'oldest';
    const cutoff =
      typeof input.olderThanDays === 'number' && input.olderThanDays > 0
        ? new Date(Date.now() - input.olderThanDays * 86_400_000)
        : null;
    const where = {
      ...(status ? { status: status as never } : {}),
      ...(cutoff ? { createdAt: { lt: cutoff } } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.task.findMany({
        where,
        orderBy: { createdAt: oldest ? ('asc' as const) : ('desc' as const) },
        take: limit,
        select: { id: true, status: true, agentName: true, createdAt: true, title: true },
      }),
      this.prisma.task.count({ where }),
    ]);
    if (!rows.length) return status || cutoff ? 'No tasks match that filter.' : 'There are no tasks.';
    const lines = rows.map(
      (t) => `${t.id} | ${t.status} | ${t.agentName ?? '-'} | ${t.createdAt.toISOString().slice(0, 16)} | ${t.title}`,
    );
    const more = total > rows.length ? `\nNOT SHOWN: ${total - rows.length} more match. Act on these, then call tasks_list again — do not tell the user it is finished while more remain.` : '';
    return `${total} matching task(s); showing the ${rows.length} ${oldest ? 'OLDEST' : 'newest'} (id | status | agent | created | title):\n${lines.join('\n')}${more}`;
  }

  async proposeTaskAction(
    currentTaskId: string,
    sessionId: string,
    input: { action: 'cancel' | 'delete'; taskIds: string[]; reason: string },
  ): Promise<ProposalResult> {
    const ids = Array.from(new Set(input.taskIds.map((s) => s.trim()).filter(Boolean)));
    if (input.action !== 'cancel' && input.action !== 'delete') return { ok: false, message: 'Rejected: action must be "cancel" or "delete".' };
    if (!ids.length || ids.length > MAX_LIST) return { ok: false, message: `Rejected: give between 1 and ${MAX_LIST} task ids.` };
    if (ids.includes(currentTaskId)) {
      return { ok: false, message: 'Rejected: you cannot act on this chat\'s own task — remove it from the list.' };
    }
    const found = await this.prisma.task.findMany({ where: { id: { in: ids } }, select: { id: true } });
    const missing = ids.filter((id) => !found.some((f) => f.id === id));
    if (missing.length) {
      return { ok: false, message: `Rejected: unknown task id(s): ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? '…' : ''}. Use tasks_list to get real ids.` };
    }

    const sorted = [...ids].sort();
    const denied = await this.proposals.requireApproval(
      currentTaskId,
      sessionId,
      PROPOSE_TASK_ACTION_TOOL,
      { action: input.action, taskIds: ids, reason: input.reason },
      (i) =>
        i.action === input.action &&
        Array.isArray(i.taskIds) &&
        JSON.stringify([...new Set((i.taskIds as unknown[]).map(String))].sort()) === JSON.stringify(sorted),
    );
    if (denied) return denied;

    let ok = 0;
    const failed: string[] = [];
    for (const id of ids) {
      try {
        if (input.action === 'delete') await this.tasks.delete(id);
        else await this.tasks.cancel(id);
        ok += 1;
      } catch (err) {
        failed.push(`${id}: ${(err as Error).message}`);
      }
    }
    this.logger.log(`Admin ${input.action}: ${ok} ok, ${failed.length} failed (task ${currentTaskId})`);
    await this.audit.record({ taskId: currentTaskId, tool: 'propose_task_action', summary: `${input.action === 'delete' ? 'Deleted' : 'Cancelled'} ${ok} task(s) — ${input.reason.slice(0, 80)}` });
    const verb = input.action === 'delete' ? 'Deleted' : 'Cancelled';
    // The real number left (this chat's own task is one of them) — so "everything is gone" is never a guess.
    const left = await this.prisma.task.count().catch(() => null);
    const leftNote = left === null ? '' : ` Tasks left on the platform right now: ${left} (including this chat's own task).${left > 1 && input.action === 'delete' ? ' If the user asked to clear more, call tasks_list again — the limit is 200 per request.' : ''}`;
    return {
      ok: failed.length === 0,
      message: `${verb} ${ok} of ${ids.length} task(s).${failed.length ? ` Failed: ${failed.slice(0, 5).join('; ')}${failed.length > 5 ? '…' : ''}` : ''}${leftNote}`,
    };
  }

  async proposeAgentDelete(
    currentTaskId: string,
    sessionId: string,
    input: { name: string; reason: string },
  ): Promise<ProposalResult> {
    const name = input.name.trim();
    if (isBuiltinAgent(name)) return { ok: false, message: `Rejected: "${name}" is a built-in agent and cannot be deleted.` };
    const existing = await this.agents.get(name).catch(() => null);
    if (!existing) return { ok: false, message: `Rejected: no agent named "${name}". Use agents_list to see what exists.` };

    const denied = await this.proposals.requireApproval(
      currentTaskId,
      sessionId,
      PROPOSE_AGENT_DELETE_TOOL,
      { name, reason: input.reason },
      (i) => i.name === name,
    );
    if (denied) return denied;

    // Snapshot the file before removing it so a wrongly approved delete can be restored by hand.
    const file = join(this.config.agentDir, 'agents', `${name}.md`);
    const content = await readFile(file, 'utf8').catch(() => null);
    let snapshot: string | null = null;
    if (content !== null) {
      const dir = join(this.config.agentDir, '.snapshots', 'agents');
      await mkdir(dir, { recursive: true });
      snapshot = join(dir, `${name}.${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
      await writeFile(snapshot, content);
    }
    await this.agents.remove(name);
    await this.audit.record({ taskId: currentTaskId, tool: 'propose_agent_delete', summary: `Deleted agent "${name}"`, undo: { kind: 'agent_delete', name, snapshot } });
    this.logger.log(`Admin deleted agent "${name}" (task ${currentTaskId})`);
    return { ok: true, message: `Agent "${name}" deleted (a snapshot is kept in agent/.snapshots/agents/).` };
  }

  private get providers(): ProvidersService {
    return this.moduleRef.get(ProvidersService, { strict: false });
  }
  private get settings(): SettingsService {
    return this.moduleRef.get(SettingsService, { strict: false });
  }

  /** Providers overview for the admin — never includes a secret, only whether one is set. */
  async providersList(): Promise<string> {
    const [rows, def] = await Promise.all([this.providers.list(), this.settings.defaultProvider()]);
    if (!rows.length) return 'No providers are configured yet.';
    return [
      'name | kind | model | authMode | key/token set | default',
      ...rows.map(
        (r) =>
          `${r.name} | ${r.kind} | ${r.model || '(none)'} | ${r.authMode} | ${r.authMode === 'codex-login' ? 'n/a (ChatGPT sign-in)' : r.secret ? 'yes' : r.kind === 'ollama' ? 'not needed' : 'NO'} | ${r.name === def ? 'DEFAULT' : ''}`,
      ),
    ].join('\n');
  }

  async providerTest(name: string): Promise<string> {
    try {
      const r = await this.providers.test(name.trim());
      if (r.ok) {
        return `OK — ${r.model ?? 'model reachable'}${r.latencyMs ? ` in ${r.latencyMs} ms` : ''}${r.toolUse === false ? '. WARNING: the model did not emit a structured tool call, so agents may not work reliably on it.' : r.toolUse ? '; tool use works.' : '.'}`;
      }
      return `FAILED — ${r.error ?? `HTTP ${r.status ?? '?'}`}`;
    } catch (err) {
      return `FAILED — ${(err as Error).message}`;
    }
  }

  // ---- content packs ---------------------------------------------------------

  async packsList(): Promise<string> {
    const packs = await (await this.packsSvc()).list();
    if (!packs.length) return 'No content packs are shipped with this release.';
    return packs
      .map(
        (p) =>
          `${p.name} — ${p.icon ?? ''} ${p.title}: ${p.description}\n  contains: ${p.total.agents} agent(s) [${[...(p.agents ?? []), ...(p.catalogAgents ?? [])].join(', ')}], ${p.total.skills} skill(s), ${p.total.resources} library note(s), ${p.total.schedules} prepared schedule(s)\n  installed here: agents ${p.installed.agents}/${p.total.agents}, skills ${p.installed.skills}/${p.total.skills}, notes ${p.installed.resources}/${p.total.resources}, schedules ${p.installed.schedules}/${p.total.schedules}`,
      )
      .join('\n');
  }

  private async checkPack(name: string, timezone: string): Promise<string | null> {
    const packs = await (await this.packsSvc()).list();
    if (!packs.some((p) => p.name === name)) return `no pack named "${name}". Available: ${packs.map((p) => p.name).join(', ') || 'none'} (see packs_list).`;
    if (timezone) {
      const { isValidTimezone } = await import('../schedules/schedule-core');
      if (!isValidTimezone(timezone)) return `unknown time zone "${timezone}" (use e.g. Europe/Kyiv, America/New_York, UTC).`;
    }
    return null;
  }

  async proposePackInstall(currentTaskId: string, sessionId: string, input: { name: string; timezone?: string; reason: string }): Promise<ProposalResult> {
    const why = await this.checkPack(input.name, input.timezone ?? '');
    if (why) return { ok: false, message: `Rejected: ${why}` };
    const denied = await this.proposals.requireApproval(
      currentTaskId,
      sessionId,
      PROPOSE_PACK_INSTALL_TOOL,
      { ...input },
      (i) => i.name === input.name && (i.timezone ?? '') === (input.timezone ?? ''),
    );
    if (denied) return denied;
    const svc = await this.packsSvc();
    const { describeReport } = await import('../packs/packs.service');
    const report = await svc.install(input.name, { timezone: input.timezone, by: 'admin agent' });
    await this.audit.record({ taskId: currentTaskId, tool: 'propose_pack_install', summary: `Installed pack "${input.name}": ${report.added.agents.length} agent(s), ${report.added.skills.length} skill(s), ${report.added.resources.length} note(s), ${report.added.schedules.length} schedule(s)` });
    return { ok: report.problems.length === 0, message: describeReport(report) };
  }

  // ---- project resources -----------------------------------------------------

  /** Why a resource proposal can't be accepted (null = fine). */
  private async checkResource(p: ResourceProposal): Promise<string | null> {
    if (!['create', 'update', 'delete'].includes(p.action)) return 'action must be create, update or delete.';
    if (p.action === 'create') {
      const bad = validateMeta({ title: p.title, description: p.description });
      if (bad) return bad;
      if (!p.text?.trim()) return 'give the note text.';
      if (p.text.length > 200_000) return 'the note is too long (max ~200 000 characters).';
      return null;
    }
    if (!p.id) return 'give the resource id (from resources_search).';
    const r = await this.resources.get(p.id).catch(() => null);
    if (!r) return `no resource with id "${p.id}". Use resources_search.`;
    if (p.action === 'delete') return null;
    if (p.text !== undefined && r.kind !== 'text') return 'only text notes can be edited — files and images are replaced in the dashboard.';
    if (p.title !== undefined || p.description !== undefined) {
      const bad = validateMeta({ title: p.title ?? r.title, description: p.description ?? r.description });
      if (bad) return bad;
    }
    return null;
  }

  async proposeResource(currentTaskId: string, sessionId: string, input: ResourceProposal): Promise<ProposalResult> {
    const why = await this.checkResource(input);
    if (why) return { ok: false, message: `Rejected: ${why}` };
    const denied = await this.proposals.requireApproval(
      currentTaskId,
      sessionId,
      PROPOSE_RESOURCE_TOOL,
      { ...input },
      (i) =>
        i.action === input.action &&
        (i.id ?? '') === (input.id ?? '') &&
        (i.title ?? '') === (input.title ?? '') &&
        String(i.text ?? '') === String(input.text ?? '') &&
        (i.description ?? '') === (input.description ?? ''),
    );
    if (denied) return denied;
    if (input.action === 'delete') {
      const r = await this.resources.get(input.id!);
      await this.resources.remove(input.id!);
      await this.audit.record({ taskId: currentTaskId, tool: 'propose_resource', summary: `Deleted resource "${r.title}"` });
      return { ok: true, message: `Resource "${r.title}" deleted.` };
    }
    if (input.action === 'create') {
      const r = await this.resources.createNote({ title: input.title, description: input.description, tags: cleanTags(input.tags), agents: input.agents, text: input.text ?? '', source: 'note' });
      await this.audit.record({ taskId: currentTaskId, tool: 'propose_resource', summary: `Added note "${r.title}"` });
      return { ok: true, message: `Note "${r.title}" added to the resource library (id ${r.id}). Agents will see it in their resource list.` };
    }
    const r = await this.resources.update(input.id!, { title: input.title, description: input.description, tags: input.tags ? cleanTags(input.tags) : undefined, agents: input.agents, text: input.text });
    await this.audit.record({ taskId: currentTaskId, tool: 'propose_resource', summary: `Changed note "${r.title}"` });
    return { ok: true, message: `Resource "${r.title}" updated.` };
  }

  // ---- chat channels ---------------------------------------------------------

  async channelsList(): Promise<string> {
    const rows = await this.channelsSvc.list();
    if (!rows.length) return 'There are no channels yet. Create one with propose_channel (then request_secret for its bot token).';
    const out: string[] = [];
    for (const r of rows) {
      const allowed = this.channelsSvc.allowedChatIds(r);
      const conn = !this.channelsSvc.isConfigured(r)
        ? 'NO TOKEN yet'
        : r.enabled
          ? await this.channelsSvc
              .test(r.id)
              .then((t) => (t.ok ? `connected${t.info ? ` (${t.info})` : ''}` : `NOT connected: ${t.error ?? '?'}`))
              .catch((e) => `NOT connected: ${(e as Error).message}`)
          : 'token set, switched off';
      const waiting = this.pairing.list(r.id);
      out.push(
        `${r.name} | ${r.kind} | ${r.enabled ? 'on' : 'off'} | ${conn} | allowed chats: ${allowed.join(', ') || 'none'} | default agent: ${this.channelsSvc.defaultAgent(r) ?? '(default lead)'}` +
          (waiting.length
            ? `\n  WAITING to be allowed: ${waiting.map((w) => `chat ${w.chatId}${w.userName ? ` (${w.userName})` : ''}${w.firstText ? ` wrote: "${w.firstText}"` : ''}`).join('; ')}`
            : ''),
      );
    }
    return ['name | kind | on/off | connection | allowed chats | default agent', ...out].join('\n');
  }

  /** Why a channel proposal can't be accepted (null = fine). */
  private async checkChannel(p: ChannelProposal): Promise<string | null> {
    if (!['create', 'update', 'delete'].includes(p.action)) return 'action must be create, update or delete.';
    const name = p.name?.trim();
    if (!name || !(await import('../schedules/schedule-core')).isValidScheduleName(name)) return 'give a short channel name (letters of any language, digits, spaces and . _ - – — : ( ) ; max 60).';
    const existing = (await this.channelsSvc.list()).find((c) => c.name === name);
    if (p.action === 'create') {
      if (existing) return `a channel named "${name}" already exists — use action update.`;
      if ((p.kind ?? 'telegram') !== 'telegram') return 'only kind "telegram" is available for now.';
    } else if (!existing) {
      return `no channel named "${name}". Use channels_list.`;
    }
    if (p.action === 'delete') return null;
    if (p.defaultAgent && !(await this.agents.get(p.defaultAgent).catch(() => null))) return `no agent named "${p.defaultAgent}".`;
    for (const [label, id] of [['allowChatId', p.allowChatId], ['removeChatId', p.removeChatId]] as const) {
      if (id && !/^-?\d{3,20}$/.test(id.trim())) return `${label} must be a Telegram chat id (digits, may start with -), e.g. 477581596.`;
    }
    if (p.enabled === true && existing && !this.channelsSvc.isConfigured(existing)) return 'it has no bot token yet — call request_secret (target channel) first; it switches on by itself once the token is saved.';
    if (p.enabled === true && p.action === 'create') return 'a new channel starts switched off and turns on by itself when its token is saved — leave `enabled` out.';
    return null;
  }

  async proposeChannel(currentTaskId: string, sessionId: string, input: ChannelProposal): Promise<ProposalResult> {
    const why = await this.checkChannel(input);
    if (why) return { ok: false, message: `Rejected: ${why}` };
    const name = input.name.trim();
    const denied = await this.proposals.requireApproval(
      currentTaskId,
      sessionId,
      PROPOSE_CHANNEL_TOOL,
      { ...input, name },
      (i) =>
        i.action === input.action &&
        String(i.name ?? '').trim() === name &&
        (i.kind ?? '') === (input.kind ?? '') &&
        (i.enabled ?? null) === (input.enabled ?? null) &&
        (i.defaultAgent ?? '') === (input.defaultAgent ?? '') &&
        (i.allowChatId ?? '') === (input.allowChatId ?? '') &&
        (i.removeChatId ?? '') === (input.removeChatId ?? ''),
    );
    if (denied) return denied;

    const { ChannelManagerService } = await import('../channels/channel-manager.service');
    const manager = this.moduleRef.get(ChannelManagerService, { strict: false });
    const existing = (await this.channelsSvc.list()).find((c) => c.name === name);
    if (input.action === 'delete') {
      await this.channelsSvc.remove(existing!.id);
      await manager.reload();
      await this.audit.record({ taskId: currentTaskId, tool: 'propose_channel', summary: `Deleted channel "${name}"` });
      return { ok: true, message: `Channel "${name}" deleted.` };
    }
    if (input.action === 'create') {
      const row = await this.channelsSvc.create({ name, kind: input.kind ?? 'telegram', config: input.defaultAgent ? { defaultAgent: input.defaultAgent } : {} }, { draft: true });
      await this.audit.record({ taskId: currentTaskId, tool: 'propose_channel', summary: `Created channel "${name}" (switched off, waiting for its bot token)` });
      void row;
      return {
        ok: true,
        message: `Channel "${name}" created, switched OFF — it has no bot token yet. Next: call request_secret (target "channel", name "${name}") so the user can enter the token from @BotFather in a secure field (never in the chat). It switches on by itself once the token is saved.`,
      };
    }
    // update
    const notes: string[] = [];
    if (input.defaultAgent !== undefined || input.enabled !== undefined) {
      await this.channelsSvc.update(existing!.id, {
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.defaultAgent !== undefined ? { config: { defaultAgent: input.defaultAgent } } : {}),
      });
      if (input.enabled !== undefined) notes.push(input.enabled ? 'switched on' : 'switched off');
      if (input.defaultAgent) notes.push(`default agent → ${input.defaultAgent}`);
    }
    if (input.removeChatId) {
      await this.channelsSvc.setChatAllowed(existing!.id, input.removeChatId.trim(), false);
      notes.push(`chat ${input.removeChatId} removed`);
    }
    if (input.allowChatId) {
      await this.channelsSvc.setChatAllowed(existing!.id, input.allowChatId.trim(), true);
      this.pairing.dismiss(existing!.id, input.allowChatId.trim());
      notes.push(`chat ${input.allowChatId} allowed`);
    }
    await manager.reload();
    if (input.allowChatId) await manager.onChatAllowed(existing!.id, input.allowChatId.trim());
    await this.audit.record({ taskId: currentTaskId, tool: 'propose_channel', summary: `Channel "${name}": ${notes.join(', ') || 'no change'}` });
    return { ok: true, message: `Channel "${name}" updated: ${notes.join(', ') || 'nothing changed'}.${input.allowChatId ? ' The chat was told it is connected.' : ''}` };
  }

  // ---- schedules -------------------------------------------------------------

  // ---- where the server answers: allowed domains + Cloudflare Access ----

  async accessStatus(): Promise<string> {
    const access = this.accessSvc;
    const cf = this.cloudflareSvc.get();
    const list = access.configured();
    return [
      list.length ? `Allowed domains (enforced): ${list.join(', ')}` : 'Allowed domains: none — any name is accepted.',
      access.publicHost() ? `Public address (PUBLIC_URL): ${access.publicHost()} — always allowed (set in the server's .env).` : 'Public address (PUBLIC_URL): not set.',
      'localhost, IP addresses and single-word names always work, whatever the list.',
      cf ? `Cloudflare Access: ${cf.enabled ? 'ON' : 'saved but OFF'} (team ${cf.teamDomain}, AUD saved).` : 'Cloudflare Access: not set up.',
      `The listen address and PUBLIC_URL are server-level (.env) settings — the user changes them with \`aigentron access\` on the server.`,
    ].join('\n');
  }

  private nextDomains(p: DomainsProposal): { next: string[]; error?: string } {
    const cur = this.accessSvc.configured();
    const { list, bad } = parseDomainList(p.domains ?? []);
    if (bad.length) return { next: cur, error: `not a domain name: ${bad.join(', ')} (use dev.example.com or *.example.com).` };
    if (p.action === 'clear') return { next: [] };
    if (!list.length) return { next: cur, error: 'give at least one domain.' };
    if (p.action === 'set') return { next: list };
    if (p.action === 'add') return { next: [...new Set([...cur, ...list])] };
    return { next: cur.filter((d) => !list.includes(d)) };
  }

  private checkDomains(p: DomainsProposal): string | null {
    if (!['add', 'remove', 'set', 'clear'].includes(p.action)) return 'action must be add, remove, set or clear.';
    if (!p.reason?.trim()) return 'give a reason.';
    const { next, error } = this.nextDomains(p);
    if (error) return error;
    const cur = this.accessSvc.configured();
    if (next.length === cur.length && next.every((d) => cur.includes(d))) return 'that would not change the list.';
    return null;
  }

  async proposeAllowedDomains(currentTaskId: string, sessionId: string, input: DomainsProposal): Promise<ProposalResult> {
    const why = this.checkDomains(input);
    if (why) return { ok: false, message: `Rejected: ${why}` };
    const denied = await this.proposals.requireApproval(
      currentTaskId,
      sessionId,
      PROPOSE_ALLOWED_DOMAINS_TOOL,
      { ...input },
      (i) => i.action === input.action && JSON.stringify(i.domains ?? []) === JSON.stringify(input.domains ?? []),
    );
    if (denied) return denied;
    const before = this.accessSvc.configured();
    const { next } = this.nextDomains(input);
    const r = this.accessSvc.save(next, undefined);
    if (!r.ok) return { ok: false, message: `Rejected: ${r.error}` };
    await this.audit.record({ taskId: currentTaskId, tool: 'propose_allowed_domains', summary: `Allowed domains: [${before.join(', ')}] → [${r.hosts.join(', ')}] — ${input.reason.slice(0, 80)}` });
    this.logger.log(`Admin changed allowed domains: ${r.hosts.join(', ') || '(none)'}`);
    return { ok: true, message: r.hosts.length ? `Allowed domains are now: ${r.hosts.join(', ')}. Takes effect immediately.` : 'The list is cleared — any domain name is accepted again.' };
  }

  private async checkCloudflare(p: CloudflareProposal): Promise<string | null> {
    if (!p.reason?.trim()) return 'give a reason.';
    const team = parseTeamDomain(p.teamDomain);
    if (!team) return 'teamDomain looks like yourteam.cloudflareaccess.com (Zero Trust → Settings → Team domain).';
    const saved = this.cloudflareSvc.get();
    if (!parseAud(p.aud ?? saved?.aud)) return 'give the Application Audience (AUD) tag — the long code on the Access application\'s Overview page.';
    if (p.enabled) {
      const r = await this.cloudflareSvc.reachable(team);
      if (!r.ok) return `could not get Cloudflare's signing keys for ${team} (${r.error}) — check the team domain.`;
    }
    if (saved && saved.enabled === p.enabled && saved.teamDomain === team && (!p.aud || p.aud === saved.aud)) return 'that is already the current setting.';
    return null;
  }

  async proposeCloudflareAccess(currentTaskId: string, sessionId: string, input: CloudflareProposal): Promise<ProposalResult> {
    const why = await this.checkCloudflare(input);
    if (why) return { ok: false, message: `Rejected: ${why}` };
    const denied = await this.proposals.requireApproval(
      currentTaskId,
      sessionId,
      PROPOSE_CLOUDFLARE_ACCESS_TOOL,
      { enabled: input.enabled, teamDomain: input.teamDomain, aud: input.aud ? '(set)' : undefined, reason: input.reason },
      (i) => i.enabled === input.enabled && String(i.teamDomain ?? '') === input.teamDomain,
    );
    if (denied) return denied;
    const r = await this.cloudflareSvc.save({ enabled: input.enabled, teamDomain: input.teamDomain, aud: input.aud }, undefined, {});
    if (!r.ok) return { ok: false, message: `Rejected: ${r.error}` };
    await this.audit.record({ taskId: currentTaskId, tool: 'propose_cloudflare_access', summary: `Cloudflare Access ${r.config.enabled ? 'ON' : 'off'} (team ${r.config.teamDomain}) — ${input.reason.slice(0, 80)}` });
    this.logger.log(`Admin set Cloudflare Access ${r.config.enabled ? 'on' : 'off'} (${r.config.teamDomain})`);
    return { ok: true, message: r.config.enabled ? `Cloudflare Access is now required on public domain names (team ${r.config.teamDomain}). localhost / IPs / the local network are unaffected.` : 'Cloudflare Access is switched off.' };
  }

  async schedulesList(): Promise<string> {
    const rows = await (await this.schedulesSvc()).list();
    if (!rows.length) return 'There are no schedules yet.';
    const chans = new Map((await this.channelsSvc.list()).map((c) => [c.id, c.name]));
    return [
      'name | when | kind → target | enabled | next run | last result',
      ...rows.map(
        (r) =>
          `${r.name} | ${describeSchedule(r.cron, r.timezone)}${r.quietStart ? ` (quiet ${r.quietStart}–${r.quietEnd})` : ''} | ${r.kind}${r.kind === 'task' ? ` → agent ${r.agentName}` : ''}${r.channelId ? ` → ${chans.get(r.channelId) ?? '?'} chat ${r.chatId}` : ''} | ${r.enabled ? 'yes' : 'NO'} | ${r.nextRunAt?.toISOString().slice(0, 16) ?? '-'} | ${r.lastStatus ?? 'never run'}${r.lastError ? ` (${r.lastError})` : ''}`,
      ),
    ].join('\n');
  }

  /** Turn the admin's request into the service's input (channel NAME → id; the chat defaults to the channel's only allowed chat). */
  private async scheduleInput(p: ScheduleProposal): Promise<{ input: Record<string, unknown>; error?: string }> {
    const input: Record<string, unknown> = {
      name: p.name?.trim(),
      cron: p.cron,
      timezone: p.timezone,
      kind: p.kind,
      text: p.text,
      agentName: p.agentName,
      quietStart: p.quietStart,
      quietEnd: p.quietEnd,
      enabled: p.enabled,
    };
    if (p.channel) {
      const ch = (await this.channelsSvc.list()).find((c) => c.name.toLowerCase() === p.channel!.trim().toLowerCase());
      if (!ch) return { input, error: `no channel named "${p.channel}". Use channels_list to see them.` };
      const allowed = this.channelsSvc.allowedChatIds(ch);
      const chat = p.chatId?.trim() || (allowed.length === 1 ? allowed[0] : undefined);
      if (!chat) return { input, error: `channel "${ch.name}" has ${allowed.length || 'no'} allowed chats — say which chatId to use.` };
      input.channelId = ch.id;
      input.chatId = chat;
    }
    return { input };
  }

  /** Why a schedule proposal can't be accepted (null = fine). */
  private async checkSchedule(p: ScheduleProposal): Promise<string | null> {
    if (!['create', 'update', 'delete'].includes(p.action)) return 'action must be create, update or delete.';
    const name = p.name?.trim();
    if (!name) return 'give the schedule name.';
    const existing = (await (await this.schedulesSvc()).list()).find((s) => s.name === name);
    if (p.action === 'delete') return existing ? null : `no schedule named "${name}". Use schedules_list.`;
    if (p.action === 'update' && !existing) return `no schedule named "${name}" to update. Use schedules_list (or action create).`;
    if (p.action === 'create' && existing) return `a schedule named "${name}" already exists — use action update.`;
    const { input, error } = await this.scheduleInput(p);
    if (error) return error;
    return (await this.schedulesSvc()).validate(input, existing ?? undefined);
  }

  async proposeSchedule(currentTaskId: string, sessionId: string, input: ScheduleProposal): Promise<ProposalResult> {
    const why = await this.checkSchedule(input);
    if (why) return { ok: false, message: `Rejected: ${why}` };
    const name = input.name.trim();
    const denied = await this.proposals.requireApproval(
      currentTaskId,
      sessionId,
      PROPOSE_SCHEDULE_TOOL,
      { ...input, name },
      (i) =>
        i.action === input.action &&
        String(i.name ?? '').trim() === name &&
        (i.cron ?? '') === (input.cron ?? '') &&
        (i.timezone ?? '') === (input.timezone ?? '') &&
        (i.kind ?? '') === (input.kind ?? '') &&
        String(i.text ?? '') === String(input.text ?? '') &&
        (i.agentName ?? '') === (input.agentName ?? '') &&
        (i.channel ?? '') === (input.channel ?? '') &&
        (i.chatId ?? '') === (input.chatId ?? ''),
    );
    if (denied) return denied;

    const existing = (await (await this.schedulesSvc()).list()).find((s) => s.name === name);
    if (input.action === 'delete') {
      await (await this.schedulesSvc()).remove(existing!.id);
      await this.audit.record({ taskId: currentTaskId, tool: 'propose_schedule', summary: `Deleted schedule "${name}" (${describeSchedule(existing!.cron, existing!.timezone)})` });
      return { ok: true, message: `Schedule "${name}" deleted.` };
    }
    const { input: data } = await this.scheduleInput(input);
    const svc = await this.schedulesSvc();
    const row = input.action === 'create' ? await svc.create(data, 'admin agent') : await svc.update(existing!.id, data);
    const when = describeSchedule(row.cron, row.timezone);
    await this.audit.record({ taskId: currentTaskId, tool: 'propose_schedule', summary: `${input.action === 'create' ? 'Created' : 'Updated'} schedule "${name}": ${when}` });
    this.logger.log(`Admin ${input.action} schedule "${name}" (${when})`);
    return {
      ok: true,
      message: `Schedule "${name}" ${input.action === 'create' ? 'created' : 'updated'}: ${when}. Next run: ${row.nextRunAt?.toISOString().slice(0, 16).replace('T', ' ')} UTC.${row.kind === 'message' ? '' : ' Each run starts a task and uses model budget.'}`,
    };
  }

  async proposeProvider(currentTaskId: string, sessionId: string, input: ProviderProposal): Promise<ProposalResult> {
    const why = validateProviderProposal(input);
    if (why) return { ok: false, message: `Rejected: ${why}` };
    const name = input.name.trim();
    const wanted = { name, kind: input.kind, model: input.model.trim(), authMode: input.authMode, baseUrl: input.baseUrl ?? null, makeDefault: input.makeDefault === true };
    const denied = await this.proposals.requireApproval(
      currentTaskId,
      sessionId,
      PROPOSE_PROVIDER_TOOL,
      { ...input, name },
      (i) =>
        i.name === name &&
        i.kind === wanted.kind &&
        String(i.model ?? '').trim() === wanted.model &&
        i.authMode === wanted.authMode &&
        ((typeof i.baseUrl === 'string' && i.baseUrl.trim() ? i.baseUrl.trim() : null) === wanted.baseUrl) &&
        (i.makeDefault === true) === wanted.makeDefault,
    );
    if (denied) return denied;

    const existing = await this.providers.list().then((rows) => rows.find((r) => r.name === name));
    const beforeDefault = await this.settings.defaultProvider();
    // The secret is never touched here: an update keeps whatever key is stored, a new provider starts without one.
    if (existing) {
      await this.providers.update(name, {
        kind: wanted.kind,
        model: wanted.model,
        authMode: wanted.authMode as never,
        ...(wanted.baseUrl !== null ? { baseUrl: wanted.baseUrl } : {}),
      });
    } else {
      await this.providers.create({
        name,
        kind: wanted.kind,
        model: wanted.model,
        authMode: wanted.authMode as never,
        baseUrl: wanted.baseUrl,
      });
    }
    if (wanted.makeDefault) await this.settings.update({ defaultProvider: name });
    const row = await this.providers.list().then((rows) => rows.find((r) => r.name === name));
    const needsKey = wanted.authMode !== 'codex-login' && wanted.kind !== 'ollama' && !row?.secret;
    this.logger.log(`Admin ${existing ? 'updated' : 'created'} provider "${name}"${wanted.makeDefault ? ' (now default)' : ''}`);
    await this.audit.record({
      taskId: currentTaskId,
      tool: 'propose_provider',
      summary: `${existing ? 'Updated' : 'Created'} provider "${name}" (${wanted.kind}, ${wanted.model})`,
      undo: { kind: 'provider', name, before: existing ? { kind: existing.kind, model: existing.model, baseUrl: existing.baseUrl, authMode: existing.authMode } : null },
    });
    if (wanted.makeDefault && beforeDefault !== name) {
      await this.audit.record({ taskId: currentTaskId, tool: 'propose_provider', summary: `Default provider: ${beforeDefault} → ${name}`, undo: { kind: 'settings', before: { defaultProvider: beforeDefault } } });
    }
    return {
      ok: true,
      message:
        `Provider "${name}" ${existing ? 'updated' : 'created'}${wanted.makeDefault ? ' and set as the default' : ''}.` +
        (needsKey
          ? ' It has NO API key/token yet: call request_secret (target provider, name "' + name + '") so the user can enter it in a secure field — never ask for it in the chat — then provider_test.'
          : wanted.authMode === 'codex-login'
            ? ' It uses a ChatGPT sign-in: tell the user to sign in once on the server with `codex login --device-auth`, then press Test in Settings → Providers.'
            : ' You can verify it with provider_test.'),
    };
  }

  private get maintenance(): MaintenanceService {
    return this.moduleRef.get(MaintenanceService, { strict: false });
  }

  async maintenanceReport(): Promise<string> {
    const r = await this.maintenance.report();
    const mb = (n: number) => `${(n / 1024 / 1024).toFixed(0)} MB`;
    return [
      `Run folders: ${r.runs.count} (${mb(r.runs.bytes)}); ${r.runs.stale} older than ${r.retentionDays} days (${mb(r.runs.staleBytes)}) — these are removed automatically every few hours.`,
      `Old git worktrees: ${r.worktrees.count} (${mb(r.worktrees.bytes)}); ${r.worktrees.stale} older than ${r.worktreeRetentionDays} days and finished — removed only on request.`,
      `agent/task-* branches in the project repo: ${r.branches.agentBranches} (${r.branches.stale} belong to finished tasks). Deleting a branch discards any commit that was never pushed.`,
    ].join('\n');
  }

  async proposeCleanup(
    currentTaskId: string,
    sessionId: string,
    input: { runs: boolean; worktrees: boolean; deleteBranches: boolean; olderThanDays?: number; reason: string },
  ): Promise<ProposalResult> {
    const why = await this.precheck(PROPOSE_CLEANUP_TOOL, input as unknown as Record<string, unknown>, currentTaskId);
    if (why) return { ok: false, message: why };
    const denied = await this.proposals.requireApproval(
      currentTaskId,
      sessionId,
      PROPOSE_CLEANUP_TOOL,
      { ...input },
      (i) =>
        (i.runs !== false) === input.runs &&
        (i.worktrees === true) === input.worktrees &&
        (i.deleteBranches === true) === input.deleteBranches &&
        (typeof i.olderThanDays === 'number' ? i.olderThanDays : undefined) === input.olderThanDays,
    );
    if (denied) return denied;
    const res = await this.maintenance.cleanup({ dryRun: false, runs: input.runs, worktrees: input.worktrees, deleteBranches: input.deleteBranches, olderThanDays: input.olderThanDays });
    this.logger.log(`Admin cleanup: ${res.runsRemoved} runs, ${res.worktreesRemoved} worktrees, ${res.branchesDeleted} branches`);
    await this.audit.record({ taskId: currentTaskId, tool: 'propose_cleanup', summary: `Cleanup: ${res.runsRemoved} run folder(s), ${res.worktreesRemoved} worktree(s), ${res.branchesDeleted} branch(es)` });
    return {
      ok: true,
      message: `Cleanup done: ${res.runsRemoved} run folder(s) removed, ${res.worktreesRemoved} worktree(s) removed, ${res.branchesDeleted} branch(es) deleted.`,
    };
  }

  /**
   * The user types the key into a secure field; the value is stored by ApprovalsService.submitSecret and only the
   * outcome comes back here. The approval being "approved" is the proof that a human submitted it.
   */
  async requestSecret(
    currentTaskId: string,
    sessionId: string,
    input: { target: 'provider' | 'github_token' | 'channel'; name?: string; reason: string },
  ): Promise<ProposalResult> {
    const why = await this.precheck(REQUEST_SECRET_TOOL, input as unknown as Record<string, unknown>, currentTaskId);
    if (why) return { ok: false, message: why };
    const denied = await this.proposals.requireApproval(
      currentTaskId,
      sessionId,
      REQUEST_SECRET_TOOL,
      { ...input },
      (i) => i.target === input.target && (i.name ?? undefined) === (input.name ?? undefined),
    );
    if (denied) return { ok: false, message: denied.message.replace(/Denied: a human rejected this change\. Nothing was changed\./, 'The user cancelled — no key was entered.') };
    if (input.target === 'provider') {
      const row = await this.providers.list().then((rows) => rows.find((r) => r.name === input.name));
      if (!row?.secret) return { ok: false, message: 'The request was closed without a key being saved (approving without entering the key does nothing).' };
      await this.audit.record({ taskId: currentTaskId, tool: 'request_secret', summary: `Key entered by the user for provider "${input.name}"` });
      return { ok: true, message: `The key for provider "${input.name}" was saved (you cannot see it). You can verify it with provider_test.` };
    }
    if (input.target === 'channel') {
      const ch = (await this.channelsSvc.list()).find((c) => c.name === input.name);
      if (!ch || !this.channelsSvc.isConfigured(ch)) return { ok: false, message: 'The request was closed without a token being saved (approving without entering it does nothing).' };
      await this.audit.record({ taskId: currentTaskId, tool: 'request_secret', summary: `Bot token entered by the user for channel "${input.name}"` });
      const check: { ok: boolean; info?: string; error?: string } = await this.channelsSvc.test(ch.id).catch((e) => ({ ok: false, error: (e as Error).message }));
      return {
        ok: true,
        message: `The bot token for channel "${input.name}" was saved (you cannot see it) and the channel was switched on. Connection check: ${check.ok ? `OK${check.info ? ` (${check.info})` : ''}` : `FAILED — ${check.error ?? 'unknown error'} (the token may be wrong)`}. Next: ask the user to send any message to the bot, then call channels_list — their chat appears as waiting — and propose_channel with allowChatId.`,
      };
    }
    const s = await this.settings.get();
    if (!s.githubToken) return { ok: false, message: 'The request was closed without a token being saved.' };
    await this.audit.record({ taskId: currentTaskId, tool: 'request_secret', summary: 'GitHub token entered by the user' });
    return { ok: true, message: 'The GitHub token was saved (you cannot see it).' };
  }

  /** One task, explained: enough for the admin to say WHY it failed or stalled, without dumping the whole transcript. */
  async taskDiagnose(taskId: string): Promise<string> {
    const t = await this.prisma.task.findUnique({
      where: { id: taskId.trim() },
      include: {
        sessions: { orderBy: { startedAt: 'asc' }, select: { provider: true, model: true, status: true, reportedStatus: true, reportedSummary: true, numTurns: true, inputTokens: true, outputTokens: true, startedAt: true, endedAt: true } },
        approvals: { orderBy: { createdAt: 'asc' }, select: { toolName: true, status: true, summary: true, reason: true } },
        subtasks: { select: { id: true, title: true, status: true } },
      },
    });
    if (!t) return `No task with id "${taskId}". Use tasks_list to get real ids.`;
    const events = await this.prisma.agentEvent.findMany({ where: { taskId: t.id }, orderBy: [{ createdAt: 'desc' }], take: 6, select: { kind: true, text: true } });
    const clip = (v: string, n: number) => (v.length > n ? `${v.slice(0, n)}…` : v);
    const line = (label: string, v: unknown) => (v === null || v === undefined || v === '' ? null : `${label}: ${v}`);
    return [
      `Task ${t.id} — "${clip(t.title, 120)}"`,
      `Status: ${t.status}${t.error ? ` · error: ${clip(t.error, 500)}` : ''}`,
      line('Agent', t.agentName ?? '(default / none)'),
      line('Created', t.createdAt.toISOString()),
      '',
      `Runs (${t.sessions.length}):`,
      ...t.sessions.map(
        (s) =>
          `  - ${s.provider}/${s.model} · ${s.status}${s.reportedStatus ? ` · agent reported ${s.reportedStatus}` : ''} · ${s.numTurns} turn(s) · ${s.inputTokens}/${s.outputTokens} tokens${s.reportedSummary ? `\n    summary: ${clip(s.reportedSummary, 400)}` : ''}`,
      ),
      t.approvals.length ? `\nApprovals (${t.approvals.length}):` : null,
      ...t.approvals.map((a) => `  - ${a.status.toUpperCase()}: ${clip(a.summary, 140)}${a.status === 'denied' ? ` (why asked: ${clip(a.reason, 120)})` : ''}`),
      t.subtasks.length ? `\nSubtasks (${t.subtasks.length}):` : null,
      ...t.subtasks.map((s) => `  - ${s.id} "${clip(s.title, 60)}" → ${s.status}`),
      events.length ? '\nLast messages (newest first):' : null,
      ...events.map((e) => `  [${e.kind}] ${clip(e.text.replace(/\s+/g, ' '), 300)}`),
    ]
      .filter((l): l is string => l !== null)
      .join('\n');
  }

  async usageReport(input: { days?: number }): Promise<string> {
    const days = Math.min(365, Math.max(1, Math.round(input.days ?? 7)));
    const stats = this.moduleRef.get(StatsService, { strict: false });
    const r = await stats.usageByProvider({ from: new Date(Date.now() - days * 86_400_000) });
    if (!r.providers.length) return `No agent runs in the last ${days} day(s).`;
    const n = (x: number) => x.toLocaleString('en-US');
    return [
      `Usage over the last ${days} day(s) — provider | runs | requests | input tok | output tok | cache tok | est. cost`,
      ...r.providers.map((p) => `${p.provider} | ${p.sessions} | ${p.requests} | ${n(p.inputTokens)} | ${n(p.outputTokens)} | ${n(p.cacheTokens)} | $${p.estCostUsd.toFixed(2)}`),
      `TOTAL | ${r.totals.sessions} | ${r.totals.requests} | ${n(r.totals.inputTokens)} | ${n(r.totals.outputTokens)} | ${n(r.totals.cacheTokens)} | $${r.totals.estCostUsd.toFixed(2)}`,
      'Cost is an estimate (exact for Anthropic, approximate/0 through LiteLLM, 0 for subscription providers such as Codex).',
    ].join('\n');
  }

  async adminHistory(input: { limit?: number }): Promise<string> {
    const rows = await this.audit.list(input.limit ?? 20);
    if (!rows.length) return 'No changes have been made through the admin yet.';
    return [
      'id | time | tool | summary | revertible',
      ...rows.map((e) => `${e.id} | ${e.ts.slice(0, 16).replace('T', ' ')} | ${e.tool} | ${e.summary} | ${e.undone ? 'already reverted' : e.undo ? 'yes' : 'no'}`),
    ].join('\n');
  }

  /** Narrow settings changes: validated, approved, journaled with their previous values. */
  async proposeSettings(currentTaskId: string, sessionId: string, input: { changes: Record<string, unknown>; reason: string }): Promise<ProposalResult> {
    const why = await this.precheck(PROPOSE_SETTINGS_TOOL, input as unknown as Record<string, unknown>, currentTaskId);
    if (why) return { ok: false, message: why };
    const canon = (o: Record<string, unknown>) => JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));
    const denied = await this.proposals.requireApproval(
      currentTaskId,
      sessionId,
      PROPOSE_SETTINGS_TOOL,
      { changes: input.changes, reason: input.reason },
      (i) => !!i.changes && typeof i.changes === 'object' && canon(i.changes as Record<string, unknown>) === canon(input.changes),
    );
    if (denied) return denied;
    const cur = (await this.settings.get()) as unknown as Record<string, unknown>;
    const before: Record<string, unknown> = {};
    for (const k of Object.keys(input.changes)) before[k] = cur[k] ?? null;
    const patch: Record<string, unknown> = { ...input.changes };
    if (patch.verifyCommands === '') patch.verifyCommands = null;
    if (patch.workspaceSubdir === '') patch.workspaceSubdir = null;
    await this.settings.update(patch as never);
    const keys = Object.keys(input.changes).join(', ');
    await this.audit.record({ taskId: currentTaskId, tool: 'propose_settings', summary: `Changed settings: ${keys} — ${input.reason.slice(0, 80)}`, undo: { kind: 'settings', before } });
    this.logger.log(`Admin changed settings: ${keys}`);
    return { ok: true, message: `Settings updated: ${keys}. The previous values are journaled, so this can be reverted (admin_history → propose_undo).` };
  }

  /** Revert one journaled change (settings / provider config / agent or skill file). */
  async proposeUndo(currentTaskId: string, sessionId: string, input: { changeId: string; reason: string }): Promise<ProposalResult> {
    const why = await this.precheck(PROPOSE_UNDO_TOOL, input as unknown as Record<string, unknown>, currentTaskId);
    if (why) return { ok: false, message: why };
    const id = input.changeId.trim();
    const denied = await this.proposals.requireApproval(currentTaskId, sessionId, PROPOSE_UNDO_TOOL, { changeId: id, reason: input.reason }, (i) => i.changeId === id);
    if (denied) return denied;
    const e = (await this.audit.get(id)) as AuditEntry;
    const u = e.undo!;
    // The journal is a file on disk: never trust its names/paths blindly.
    if ((u.kind === 'agent' || u.kind === 'agent_delete' || u.kind === 'skill') && (!/^[\w-]{1,60}$/.test(u.name) || (u.kind !== 'skill' && isBuiltinAgent(u.name)))) {
      return { ok: false, message: 'Refusing to revert: the journal entry has an invalid or protected name.' };
    }
    if ((u.kind === 'agent' || u.kind === 'agent_delete' || u.kind === 'skill') && u.snapshot && !resolve(u.snapshot).startsWith(resolve(this.config.agentDir, '.snapshots') + sep)) {
      return { ok: false, message: 'Refusing to revert: the snapshot is outside the snapshots folder.' };
    }
    try {
      if (u.kind === 'settings') {
        await this.settings.update(u.before as never);
      } else if (u.kind === 'provider') {
        if (u.before === null) await this.providers.remove(u.name);
        else await this.providers.update(u.name, { kind: u.before.kind, model: u.before.model, baseUrl: u.before.baseUrl, authMode: u.before.authMode as never });
      } else if (u.kind === 'agent' || u.kind === 'agent_delete') {
        const file = join(this.config.agentDir, 'agents', `${u.name}.md`);
        if (u.snapshot) await copyFile(u.snapshot, file);
        else await unlink(file);
      } else if (u.kind === 'skill') {
        const file = join(this.config.agentDir, 'skills', 'core', 'custom', `${u.name}.md`);
        if (u.snapshot) await copyFile(u.snapshot, file);
        else await unlink(file);
      }
    } catch (err) {
      return { ok: false, message: `Could not revert: ${(err as Error).message}` };
    }
    await this.audit.markUndone(id);
    await this.audit.record({ taskId: currentTaskId, tool: 'propose_undo', summary: `Reverted change ${id}: ${e.summary}` });
    this.logger.log(`Admin reverted change ${id}`);
    return { ok: true, message: `Reverted: ${e.summary}` };
  }

  /** Start a task for another agent on the user's behalf. */
  async proposeTask(currentTaskId: string, sessionId: string, input: { agentName: string; prompt: string; title?: string; reason: string }): Promise<ProposalResult> {
    const why = await this.precheck(PROPOSE_TASK_TOOL, input as unknown as Record<string, unknown>, currentTaskId);
    if (why) return { ok: false, message: why };
    const denied = await this.proposals.requireApproval(
      currentTaskId,
      sessionId,
      PROPOSE_TASK_TOOL,
      { ...input },
      (i) => i.agentName === input.agentName && i.prompt === input.prompt,
    );
    if (denied) return denied;
    const task = await this.tasks.create({ prompt: input.prompt, title: input.title, agentName: input.agentName, autostart: true } as never);
    await this.audit.record({ taskId: currentTaskId, tool: 'propose_task', summary: `Started task ${task.id} for agent "${input.agentName}" — ${(input.title ?? input.prompt).replace(/\s+/g, ' ').slice(0, 70)}` });
    this.logger.log(`Admin started task ${task.id} for agent ${input.agentName}`);
    return { ok: true, message: `Task ${task.id} started for agent "${input.agentName}". Check on it later with task_diagnose; the user can also open it in the dashboard.` };
  }

  /** All-or-nothing validation of a batch BEFORE any card is shown. Later items may use agents created by earlier ones. */
  private async validateBatch(items: unknown, currentTaskId: string, reason: string): Promise<string | null> {
    if (!Array.isArray(items) || !items.length || items.length > 12) return 'Refused: a batch needs 1–12 items.';
    if (!reason.trim()) return 'Refused: give a reason for the batch.';
    const str = (v: unknown) => (typeof v === 'string' ? v : '');
    const planned = new Set<string>();
    const errors: string[] = [];
    for (const [n, raw] of (items as { kind?: unknown; args?: unknown }[]).entries()) {
      const kind = str(raw?.kind);
      const a = (raw?.args && typeof raw.args === 'object' ? raw.args : {}) as Record<string, unknown>;
      let why: string | null;
      switch (kind) {
        case 'agent':
          why = this.proposals.validateAgent(str(a.name), str(a.content));
          if (!why) planned.add(str(a.name));
          break;
        case 'skill':
          why = await this.proposals.validateSkill(str(a.name), str(a.content));
          break;
        case 'agent_delete':
          why = await this.precheck(PROPOSE_AGENT_DELETE_TOOL, a, currentTaskId);
          break;
        case 'provider':
          why = validateProviderProposal(a as Partial<ProviderProposal>);
          break;
        case 'settings':
          why = await this.precheck(PROPOSE_SETTINGS_TOOL, a, currentTaskId, planned);
          break;
        case 'task':
          why = await this.precheck(PROPOSE_TASK_TOOL, a, currentTaskId, planned);
          break;
        case 'task_action':
          why = await this.precheck(PROPOSE_TASK_ACTION_TOOL, a, currentTaskId);
          break;
        default:
          why = `unknown kind "${kind}" (allowed: agent, skill, agent_delete, provider, settings, task, task_action).`;
      }
      if (why) errors.push(`item ${n + 1} (${kind || '?'}): ${why.replace(/^Refused: /, '')}`);
    }
    return errors.length ? `Refused — nothing was shown to the user, nothing was changed. Fix and resubmit: ${errors.join(' | ')}` : null;
  }

  private async applyBatchItem(taskId: string, sessionId: string, it: { kind: string; args: Record<string, unknown> }): Promise<ProposalResult> {
    const a = it.args;
    const s = (v: unknown) => (typeof v === 'string' ? v : '');
    switch (it.kind) {
      case 'agent':
        return this.proposals.proposeAgent(taskId, sessionId, s(a.name), s(a.content));
      case 'skill':
        return this.proposals.proposeSkill(taskId, sessionId, s(a.name), s(a.content));
      case 'agent_delete':
        return this.proposeAgentDelete(taskId, sessionId, { name: s(a.name), reason: s(a.reason) });
      case 'provider':
        return this.proposeProvider(taskId, sessionId, a as unknown as ProviderProposal);
      case 'settings':
        return this.proposeSettings(taskId, sessionId, { changes: (a.changes ?? {}) as Record<string, unknown>, reason: s(a.reason) });
      case 'task':
        return this.proposeTask(taskId, sessionId, { agentName: s(a.agentName), prompt: s(a.prompt), title: s(a.title) || undefined, reason: s(a.reason) });
      case 'task_action':
        return this.proposeTaskAction(taskId, sessionId, { action: a.action as 'cancel' | 'delete', taskIds: (a.taskIds as string[]) ?? [], reason: s(a.reason) });
      default:
        return { ok: false, message: `unknown kind ${it.kind}` };
    }
  }

  /** One approval for N related changes; applied in order via the normal code paths (each validated and journaled). */
  async proposeBatch(currentTaskId: string, sessionId: string, input: { items: { kind: string; args: Record<string, unknown> }[]; reason: string }): Promise<ProposalResult> {
    const why = await this.validateBatch(input.items, currentTaskId, input.reason);
    if (why) return { ok: false, message: why };
    const stable = (v: unknown): string =>
      JSON.stringify(v, (_k, val) => (val && typeof val === 'object' && !Array.isArray(val) ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([x], [y]) => x.localeCompare(y))) : val));
    const denied = await this.proposals.requireApproval(
      currentTaskId,
      sessionId,
      PROPOSE_BATCH_TOOL,
      { items: input.items, reason: input.reason },
      (i) => stable(i.items) === stable(input.items),
    );
    if (denied) return denied;

    const lines: string[] = [];
    let applied = 0;
    // The batch card WAS the approval: inside this scope the single-change paths skip theirs but still validate and journal.
    await batchScope.run({ approved: true }, async () => {
      for (const [n, it] of input.items.entries()) {
        const r = await this.applyBatchItem(currentTaskId, sessionId, it).catch((e: Error) => ({ ok: false, message: e.message }));
        lines.push(`${n + 1}. ${it.kind}: ${r.ok ? 'applied' : 'FAILED'} — ${r.message}`);
        if (!r.ok) break;
        applied += 1;
      }
    });
    const total = input.items.length;
    await this.audit.record({ taskId: currentTaskId, tool: 'propose_batch', summary: `Batch: ${applied} of ${total} change(s) applied — ${input.reason.slice(0, 80)}` });
    this.logger.log(`Admin batch: ${applied}/${total} applied`);
    return {
      ok: applied === total,
      message: `${applied} of ${total} change(s) applied${applied < total ? ` — stopped at item ${applied + 1}; the earlier ones are in place and can be reverted individually (admin_history → propose_undo)` : ''}.\n${lines.join('\n')}`,
    };
  }
}
