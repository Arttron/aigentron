import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { PROPOSE_LEARNED_SKILL_TOOL } from '@lds/shared';
import { AppConfigService } from '../config/app-config.service';
import { ApprovalsService } from '../approvals/approvals.service';

/** Per-file and total-directory budgets — mirrors agent/skills/learned/README.md. */
const MAX_FILE_BYTES = 16 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024;
const NAME_RE = /^[a-z0-9-]+$/;

/**
 * Roadmap Phase 6 (skill lifecycle) — the write side of `agent/skills/learned/`.
 * An agent's `propose_learned_skill` tool call lands here: validated, routed
 * through the SAME human-approval gate as any other dangerous action
 * (classify.ts carves out an explicit exception for this one internal tool —
 * every other internal tool is exempt), and — once approved — snapshotted
 * before the write so a bad approval rolls back with one `cp`.
 *
 * ApprovalsService is resolved lazily via ModuleRef, NOT constructor-injected:
 * RealAgentExecutor (AgentModule, pulled in by TasksModule) depends on this
 * service, and ApprovalsModule itself imports TasksModule — a straight
 * constructor dependency on ApprovalsService here closes that into a real
 * circular provider dependency (deadlocks Nest's DI at boot, confirmed by
 * running it). Deferring the lookup to first use sidesteps the ordering
 * question entirely — by the time propose() is called the whole app is up.
 */
@Injectable()
export class SkillsLearnedService {
  private readonly logger = new Logger(SkillsLearnedService.name);
  private approvalsCache?: ApprovalsService;

  constructor(
    private readonly config: AppConfigService,
    private readonly moduleRef: ModuleRef,
  ) {}

  private get approvals(): ApprovalsService {
    if (!this.approvalsCache) this.approvalsCache = this.moduleRef.get(ApprovalsService, { strict: false });
    return this.approvalsCache;
  }

  private get dir(): string {
    return join(this.config.agentDir, 'skills', 'learned');
  }

  private get snapshotsDir(): string {
    return join(this.dir, '.snapshots');
  }

  async propose(
    taskId: string,
    agentSessionId: string,
    name: string,
    content: string,
  ): Promise<{ ok: boolean; message: string }> {
    if (!NAME_RE.test(name)) {
      return {
        ok: false,
        message: `Rejected: "${name}" must be lowercase-with-hyphens only (no path separators, dots, or extension).`,
      };
    }

    const budgetError = await this.checkBudget(name, content);
    if (budgetError) return { ok: false, message: budgetError };

    const approval = await this.approvals.check({
      taskId,
      agentSessionId,
      toolName: PROPOSE_LEARNED_SKILL_TOOL,
      toolInput: { name, content },
    });
    let status: string;
    if (approval.allow) {
      status = 'approved'; // pre-approved by an exception/allowlist — same effect
    } else if (!approval.approvalId) {
      // Denied inline (e.g. the repeat-limit loop guard) — no approval row was created.
      return { ok: false, message: `Denied: ${approval.reason}` };
    } else {
      const resolved = await this.approvals.waitForVerdict(approval.approvalId);
      status = resolved.status;
    }

    if (status !== 'approved') {
      return {
        ok: false,
        message:
          status === 'timeout'
            ? 'Denied: no human responded before the approval timed out (fail-closed).'
            : 'Denied: a human rejected this write.',
      };
    }

    const path = join(this.dir, `${name}.md`);
    await this.snapshotIfExists(name, path);
    await mkdir(this.dir, { recursive: true });
    await writeFile(path, content);
    this.logger.log(`Wrote learned skill "${name}" (${Buffer.byteLength(content, 'utf8')} bytes)`);
    return { ok: true, message: `Approved and written to agent/skills/learned/${name}.md.` };
  }

  /** Copies the current file to .snapshots/<name>.<timestamp>.md before it's overwritten. */
  private async snapshotIfExists(name: string, path: string): Promise<void> {
    const current = await readFile(path, 'utf8').catch(() => null);
    if (current === null) return;
    await mkdir(this.snapshotsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const snapshotPath = join(this.snapshotsDir, `${name}.${stamp}.md`);
    await writeFile(snapshotPath, current);
    this.logger.log(`Snapshotted previous "${name}" -> ${snapshotPath}`);
  }

  /** Null if within budget; otherwise the rejection message (no side effects either way). */
  private async checkBudget(name: string, content: string): Promise<string | null> {
    const newBytes = Buffer.byteLength(content, 'utf8');
    if (newBytes > MAX_FILE_BYTES) {
      return `Rejected: ${newBytes} bytes exceeds the ${MAX_FILE_BYTES}-byte per-file budget — consolidate instead of growing this file further.`;
    }
    const entries = await readdir(this.dir, { withFileTypes: true }).catch(() => []);
    let existingTotal = 0;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name.toLowerCase() === 'readme.md') continue;
      if (entry.name === `${name}.md`) continue; // replaced, not added — excluded from the "existing" sum
      existingTotal += await stat(join(this.dir, entry.name)).then((s) => s.size).catch(() => 0);
    }
    const projectedTotal = existingTotal + newBytes;
    if (projectedTotal > MAX_TOTAL_BYTES) {
      return (
        `Rejected: this would bring agent/skills/learned/ to ${projectedTotal} bytes, over the ` +
        `${MAX_TOTAL_BYTES}-byte total budget — consolidate/prune existing files first.`
      );
    }
    return null;
  }
}
