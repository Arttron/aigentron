import { Body, Controller, Delete, Get, HttpCode, Put, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { WebServerService } from './web-server.service';
import { RolesGuard } from '../identity/roles.guard';
import { Roles } from '../identity/roles.decorator';

/** Settings → General → Web server (ports and certificate) and `aigentron access`. */
@Controller('web-server')
export class WebServerController {
  constructor(private readonly web: WebServerService) {}

  @Get()
  status() {
    return this.web.status();
  }

  @Put('config')
  @HttpCode(200)
  @UseGuards(RolesGuard)
  @Roles('operator', 'admin')
  async config(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const r = await this.web.setConfig(body);
    if (!r.ok) res.status(400);
    return r.ok ? { ok: true, ...this.web.status() } : r;
  }

  @Put('certificate')
  @HttpCode(200)
  @UseGuards(RolesGuard)
  @Roles('operator', 'admin')
  async certificate(@Body() body: { cert?: unknown; key?: unknown }, @Res({ passthrough: true }) res: Response) {
    const r = await this.web.setCertificate(body?.cert, body?.key);
    if (!r.ok) res.status(400);
    return r.ok ? { ok: true, ...this.web.status() } : r;
  }

  @Delete('certificate')
  @HttpCode(200)
  @UseGuards(RolesGuard)
  @Roles('operator', 'admin')
  async removeCertificate() {
    await this.web.removeCertificate();
    return { ok: true, ...this.web.status() };
  }
}
