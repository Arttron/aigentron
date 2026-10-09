import { Body, Controller, Get, HttpCode, Put, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AccessService } from './access.service';
import { AppConfigService } from '../config/app-config.service';
import { publicOrigin } from '../config/cors';
import { normalizeHost } from './access-core';
import { RolesGuard } from '../identity/roles.guard';
import { Roles } from '../identity/roles.decorator';

@Controller('access')
export class AccessController {
  constructor(
    private readonly access: AccessService,
    private readonly config: AppConfigService,
  ) {}

  /** The allowed domains and the address this request came in on (so the UI can warn before a lock-out). */
  @Get()
  get(@Req() req: Request) {
    return {
      allowedHosts: this.access.configured(),
      publicHost: this.access.publicHost(),
      yourHost: normalizeHost(req.headers.host),
      enforced: this.access.effective().length > 0,
      // read-only facts about how the server is reachable — they are set in the server's .env (see `aigentron access`)
      server: {
        port: this.config.port,
        listenHost: process.env.ORCHESTRATOR_HOST?.trim() || '0.0.0.0',
        bindAddress: process.env.BIND_ADDRESS?.trim() || null,
        publicUrl: publicOrigin(process.env.PUBLIC_URL) ?? null,
      },
    };
  }

  @Put()
  @HttpCode(200)
  @UseGuards(RolesGuard)
  @Roles('operator', 'admin')
  set(@Body() body: { allowedHosts?: unknown }, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const r = this.access.save(body?.allowedHosts, req.headers.host);
    if (!r.ok) {
      res.status(400);
      return { ok: false, error: r.error };
    }
    return { ok: true, allowedHosts: r.hosts };
  }
}
