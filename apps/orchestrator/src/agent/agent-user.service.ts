import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { assertIsolationReady, resolveClaudeExecutable, runAsAgent, type AgentIsolation } from '@lds/agent-runner';
import { AppConfigService } from '../config/app-config.service';
import { applyChownPlan, chownPlan, isolationFor, type ChownPlanInput } from './agent-user';

const pexec = promisify(execFile);

/**
 * Applies the agent-user policy for the executor: a boot-time self-check (fail
 * closed: when AGENT_RUN_AS_UID is set but the wrapper/setpriv/user/permissions
 * are broken every run refuses to start with the reason) and the per-run
 * ownership pass. Nothing here runs when the env is unset.
 */
@Injectable()
export class AgentUserService implements OnModuleInit {
  private readonly logger = new Logger(AgentUserService.name);
  /** Why isolation is unusable (null = fine, or not enabled). */
  private broken: string | null = null;

  constructor(private readonly config: AppConfigService) {}

  get enabled(): boolean {
    return this.config.agentRunAs !== null;
  }

  async onModuleInit(): Promise<void> {
    if (!this.config.agentRunAs) return;
    this.broken = await this.selfCheck();
    if (this.broken) this.logger.error(`agent isolation is ON (AGENT_RUN_AS_UID=${this.config.agentRunAs.uid}) but BROKEN — agent runs will refuse to start: ${this.broken}`);
    else this.logger.log(`agents run as uid ${this.config.agentRunAs.uid} / gid ${this.config.agentRunAs.gid} through ${this.config.agentExecWrapper}`);
  }

  /**
   * Through the very wrapper the runs use: it must switch to the uid, the agent
   * must NOT read the secrets dir / database, and it MUST read the hook, the
   * shared dist and the Claude binary. Also makes root's git accept agent-owned
   * checkouts (system gitconfig; `harden.sh` does the same for shells).
   */
  private async selfCheck(): Promise<string | null> {
    const runAs = this.config.agentRunAs!;
    const iso = isolationFor(runAs, this.config.agentExecWrapper, join(this.config.agentDir, 'runs', '.preflight'));
    try {
      await assertIsolationReady(iso);
    } catch (err) {
      return (err as Error).message;
    }
    const readable = async (p: string) => (await runAsAgent(iso, 'test', ['-r', p])).code === 0;
    const exists = (p: string) => stat(p).then(() => true, () => false);
    if ((await exists(this.config.secretsDir)) && (await readable(this.config.secretsDir))) return `${this.config.secretsDir} is readable by uid ${runAs.uid} — run infra/harden.sh (chmod 700)`;
    const db = this.config.databaseUrl.startsWith('file:') ? this.config.databaseUrl.slice(5) : '';
    if (db && (await exists(db)) && (await readable(db))) return `${db} is readable by uid ${runAs.uid} — run infra/harden.sh (chmod 600)`;
    let claude = '';
    try {
      claude = resolveClaudeExecutable();
    } catch (err) {
      return (err as Error).message;
    }
    for (const p of [this.config.hookScriptPath, this.config.sharedDistPath, claude].filter(Boolean)) {
      if (!(await readable(p))) return `${p} is not readable by uid ${runAs.uid} (the release files must be world-readable)`;
    }
    await this.allowAgentOwnedRepos();
    return null;
  }

  /** Root's git refuses "dubious ownership" of agent-owned checkouts: whitelist them once in the system gitconfig. */
  private async allowAgentOwnedRepos(): Promise<void> {
    const listed = await pexec('git', ['config', '--system', '--get-all', 'safe.directory']).then(({ stdout }) => stdout.split('\n'), () => [] as string[]);
    if (listed.includes('*')) return;
    await pexec('git', ['config', '--system', '--add', 'safe.directory', '*']).catch((err) => this.logger.warn(`could not add safe.directory=* to the system gitconfig: ${(err as Error).message}`));
  }

  /**
   * Called by the executor right before a run: null when isolation is off;
   * otherwise the ownership pass is applied and the runner's params returned.
   * Throws (→ the task fails with this message) when isolation is on but broken.
   */
  async prepareRun(p: Pick<ChownPlanInput, 'worktreePath' | 'attachmentsDir' | 'repoPath' | 'shared' | 'workspaceDir'> & { taskId: string }): Promise<AgentIsolation | null> {
    const runAs = this.config.agentRunAs;
    if (!runAs) return null;
    if (this.broken) throw new Error(`agent isolation (AGENT_RUN_AS_UID) is enabled but not working — refusing to run the agent as root: ${this.broken}`);
    const runDir = join(this.config.agentDir, 'runs', p.taskId);
    // The task's PROJECT decides the checkout, the mode and the folder (the default project's are the installation's own).
    const plan = chownPlan({
      runDir,
      worktreePath: p.worktreePath,
      repoPath: p.repoPath,
      shared: p.shared,
      workspaceDir: p.workspaceDir,
      attachmentsDir: p.attachmentsDir,
    });
    await applyChownPlan(plan, runAs);
    return isolationFor(runAs, this.config.agentExecWrapper, runDir);
  }
}
