import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';

/**
 * Makes sure the built-in `admin` agent exists — once. Fresh installs get it as
 * their only agent; existing installs get it added next to what they already
 * have (their agents and `defaultAgent` are never touched). A marker file means
 * a user who deletes the admin is not re-seeded on the next boot.
 *
 * Source: `<shippedAgentDir>/builtin/admin.md`. Not under `agents/` on purpose —
 * in the dev stack `agents/` is the LIVE bind-mounted dir.
 */
@Injectable()
export class AdminAgentSeedService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AdminAgentSeedService.name);

  constructor(private readonly config: AppConfigService) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.seed().catch((err) => this.logger.warn(`Admin agent seed skipped: ${(err as Error).message}`));
  }

  async seed(): Promise<boolean> {
    const marker = join(this.config.agentDir, '.sync', 'admin-seeded');
    if (await exists(marker)) return false;

    const target = join(this.config.agentDir, 'agents', 'admin.md');
    if (!(await exists(target))) {
      const source = join(this.config.shippedAgentDir, 'builtin', 'admin.md');
      if (!(await exists(source))) {
        this.logger.warn(`No built-in admin agent shipped at ${source}`);
        return false;
      }
      await mkdir(join(this.config.agentDir, 'agents'), { recursive: true });
      await copyFile(source, target);
      // Baseline for the three-way merge in AgentFilesSyncService, so later releases update it.
      const base = join(this.config.agentDir, '.sync', 'base', 'agents', 'admin.md');
      await mkdir(join(this.config.agentDir, '.sync', 'base', 'agents'), { recursive: true });
      await copyFile(source, base);
      this.logger.log('Seeded built-in admin agent');
    }
    await mkdir(join(this.config.agentDir, '.sync'), { recursive: true });
    await writeFile(marker, new Date().toISOString());
    return true;
  }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}
