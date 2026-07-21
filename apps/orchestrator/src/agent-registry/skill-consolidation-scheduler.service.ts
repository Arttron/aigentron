import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { SettingsService } from '../settings/settings.service';
import { TasksService } from '../tasks/tasks.service';
import { AgentRegistryService } from './agent-registry.service';

/** How often to check whether a consolidation review is due (not the review's own cadence). */
const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const STARTUP_CHECK_DELAY_MS = 30_000;

const CONSOLIDATION_PROMPT =
  'Review every file in agent/skills/learned/ (ignore README.md). Consolidate: merge ' +
  'duplicate/related observations, drop anything stale or superseded, tighten wording, and ' +
  'split unrelated topics into separate files if a single file has grown to cover more than ' +
  'one. For each file that should change, call propose_learned_skill with the full replacement ' +
  'content (a human will approve or reject each one — that IS the review, not a rubber stamp). ' +
  "If something here is durable, fleet-wide convention rather than a project-specific quirk, " +
  'say so in your summary as a suggestion to promote it into agent/skills/core/ — that promotion ' +
  'is a human decision made as a normal reviewed change, not something you write directly. ' +
  'Leave files that are already fine untouched. Report done with a one-line summary of what changed.';

/**
 * Roadmap Phase 6 (skill lifecycle) — schedules the periodic, human-reviewed
 * consolidation pass over agent/skills/learned/. Deliberately a SEPARATE
 * scheduled task, never something an agent does to its own output inside the
 * turn that produced it (see agent/skills/learned/README.md) — self-
 * consolidation in the same session biases toward describing one's own work
 * favorably rather than accurately.
 *
 * No cron dependency: a plain setInterval checks hourly whether the
 * configured interval (AppSettings.skillConsolidationIntervalDays) has
 * elapsed since the last run; the actual consolidation work happens in a
 * normal agent task using the existing propose_learned_skill + approval path
 * (SkillsLearnedService) — this service only decides WHEN to ask for one.
 */
@Injectable()
export class SkillConsolidationSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SkillConsolidationSchedulerService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly config: AppConfigService,
    private readonly settings: SettingsService,
    private readonly tasks: TasksService,
    private readonly agents: AgentRegistryService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.checkAndSchedule(), CHECK_INTERVAL_MS);
    setTimeout(() => void this.checkAndSchedule(), STARTUP_CHECK_DELAY_MS);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async checkAndSchedule(): Promise<void> {
    try {
      const row = await this.settings.get();
      const intervalMs = row.skillConsolidationIntervalDays * 24 * 60 * 60 * 1000;
      const due =
        !row.lastSkillConsolidationAt || Date.now() - row.lastSkillConsolidationAt.getTime() >= intervalMs;
      if (!due) return;

      if (!(await this.learnedHasContent())) {
        // Nothing to review yet — record the check so we don't re-evaluate on
        // every hourly tick, without creating a no-op task.
        await this.settings.markSkillConsolidationRun();
        return;
      }

      const requested = row.skillConsolidationAgent;
      const requestedExists = requested ? await this.agents.get(requested).catch(() => null) : null;
      const agentName = requestedExists ? requested! : ((await this.settings.defaultAgent()) ?? undefined);

      const task = await this.tasks.create({
        prompt: CONSOLIDATION_PROMPT,
        title: 'Consolidate learned skills',
        agentName,
      });
      await this.settings.markSkillConsolidationRun();
      this.logger.log(`Scheduled skill-consolidation review as task ${task.id} (agent=${agentName ?? 'default'})`);
    } catch (e) {
      this.logger.warn(`Consolidation check failed: ${(e as Error).message}`);
    }
  }

  private async learnedHasContent(): Promise<boolean> {
    const dir = join(this.config.agentDir, 'skills', 'learned');
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    return entries.some((e) => e.isFile() && e.name.endsWith('.md') && e.name.toLowerCase() !== 'readme.md');
  }
}
