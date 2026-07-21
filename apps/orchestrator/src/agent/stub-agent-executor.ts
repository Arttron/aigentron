import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Injectable, Logger } from '@nestjs/common';
import { AgentExecutor, type AgentRunOutcome, type TaskRunContext } from './agent-executor';

const exec = promisify(execFile);

/**
 * Placeholder executor used before the real agent runtime is wired in. It
 * writes a marker file and commits it on the task branch — enough to prove the
 * queue -> worktree -> branch pipeline end to end.
 */
@Injectable()
export class StubAgentExecutor extends AgentExecutor {
  private readonly logger = new Logger(StubAgentExecutor.name);

  async run(ctx: TaskRunContext): Promise<AgentRunOutcome> {
    this.logger.log(`[stub] running for task ${ctx.taskId} in ${ctx.worktreePath}`);
    const marker = join(ctx.worktreePath, 'AGENT_RAN.md');
    await writeFile(marker, `Stub agent ran for task ${ctx.taskId} at ${new Date().toISOString()}\n`);
    await exec('git', ['add', 'AGENT_RAN.md'], { cwd: ctx.worktreePath });
    await exec('git', ['commit', '-m', `chore: stub agent run for ${ctx.taskId}`], {
      cwd: ctx.worktreePath,
    });
    return { reported: 'done', errored: false, timedOut: false };
  }
}
