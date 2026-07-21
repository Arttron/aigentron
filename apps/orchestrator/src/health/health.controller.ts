import { Controller, Get } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
  ) {}

  @Get()
  async health() {
    let db = false;
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      db = true;
    } catch {
      db = false;
    }
    // Minimal profile only: litellm is an orchestrator-managed child process
    // (LitellmManagedService), not a separately-monitored container — folding
    // its reachability in here is what the single image's healthcheck probes.
    let litellm: boolean | undefined;
    if (this.config.litellmManaged) {
      litellm = await fetch(`${this.config.litellmBaseUrl}/v1/models`, {
        headers: { authorization: `Bearer ${this.config.litellmMasterKey}` },
      })
        .then((r) => r.ok)
        .catch(() => false);
    }
    const ok = db && litellm !== false;
    return {
      status: ok ? 'ok' : 'degraded',
      version: process.env.APP_VERSION ?? 'dev',
      db,
      ...(litellm !== undefined ? { litellm } : {}),
      ts: new Date().toISOString(),
    };
  }
}
