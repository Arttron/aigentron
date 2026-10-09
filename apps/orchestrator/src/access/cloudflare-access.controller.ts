import { Body, Controller, Get, HttpCode, Post, Put, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { CloudflareAccessService } from './cloudflare-access.service';
import { RolesGuard } from '../identity/roles.guard';
import { Roles } from '../identity/roles.decorator';

/** Settings → General → Cloudflare Access (and `aigentron access`). */
@Controller('cloudflare-access')
export class CloudflareAccessController {
  constructor(private readonly cf: CloudflareAccessService) {}

  @Get()
  get() {
    const c = this.cf.get();
    return { configured: c !== null, enabled: c?.enabled ?? false, teamDomain: c?.teamDomain ?? '', audSet: Boolean(c?.aud), audHint: c ? `…${c.aud.slice(-6)}` : null };
  }

  @Put()
  @HttpCode(200)
  @UseGuards(RolesGuard)
  @Roles('operator', 'admin')
  async set(@Body() body: { enabled?: unknown; teamDomain?: unknown; aud?: unknown }, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const r = await this.cf.save(body ?? {}, req.headers.host, req.headers);
    if (!r.ok) {
      res.status(400);
      return { ok: false, error: r.error };
    }
    return { ok: true, enabled: r.config.enabled, teamDomain: r.config.teamDomain };
  }

  /** Can this server fetch Cloudflare's keys, and does THIS request carry a valid Access token (and whose)? */
  @Post('test')
  @HttpCode(200)
  @UseGuards(RolesGuard)
  @Roles('operator', 'admin')
  test(@Req() req: Request) {
    return this.cf.test(req.headers);
  }
}
