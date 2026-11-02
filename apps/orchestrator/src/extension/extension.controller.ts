import { Body, Controller, Delete, Put, UseGuards, ForbiddenException, Get, HttpCode, NotFoundException, Param, Post, Query, Req, Res, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthService } from '../auth/auth.service';
import { ExtensionDevicesService } from '../auth/extension-devices.service';
import { LoginLimiter } from '../auth/auth-core';
import { UsersService } from '../users/users.service';
import { ExtensionService } from './extension.service';
import { ClipService } from './clip.service';
import { BrowserMcpService } from '../browser-control/browser-mcp.service';
import { Roles } from '../identity/roles.decorator';
import { RolesGuard } from '../identity/roles.guard';
import { originOf } from './extension-package';

type AuthedRequest = Request & { authUserId?: string; extensionDeviceId?: string };

/** The origin this request came to (behind a proxy: from the forwarded headers). */
function requestOrigin(req: Request): string | null {
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.split(',')[0]?.trim();
  const proto = first(req.headers['x-forwarded-proto']) || req.protocol || 'http';
  const host = first(req.headers['x-forwarded-host']) || req.headers.host;
  return host ? originOf(`${proto}://${host}`) : null;
}

@Controller('extension')
export class ExtensionController {
  private readonly limiter = new LoginLimiter(10);

  constructor(
    private readonly ext: ExtensionService,
    private readonly auth: AuthService,
    private readonly devices: ExtensionDevicesService,
    private readonly users: UsersService,
    private readonly clipper: ClipService,
    private readonly browser: BrowserMcpService,
  ) {}

  /** What the Add-ons → Extension tab shows: the package, and the browsers paired with this server. */
  @Get('info')
  async info(@Req() req: AuthedRequest) {
    const origin = requestOrigin(req);
    const viewer = req.authUserId ? await this.auth.userById(req.authUserId) : null;
    const manager = !this.auth.isConfigured() || viewer?.role === 'operator' || viewer?.role === 'admin';
    const names = new Map((await this.users.list()).map((u) => [u.id, u.displayName]));
    const devices = this.devices
      .list()
      .filter((d) => manager || d.userId === viewer?.id)
      .map((d) => ({ id: d.id, label: d.label, user: names.get(d.userId) ?? '(removed user)', createdAt: d.createdAt, lastSeenAt: d.lastSeenAt, version: d.version ?? null, outdated: isOutdated(d.version, this.ext.extensionVersion) }));
    return {
      available: await this.ext.templateAvailable(),
      /** the server has a sign-in: the extension then acts as the person who presses Connect; without one it acts as the default operator */
      signInOn: this.auth.isConfigured(),
      version: this.ext.version,
      extensionVersion: this.ext.extensionVersion,
      extensionId: this.ext.extensionId(),
      origins: this.ext.originsFor(origin, []),
      devices,
      /** agents get the browser tools automatically while an extension is paired (this is the switch) */
      agentsBrowser: this.browser.enabled,
    };
  }

  /**
   * The zip of this server's extension (its addresses and key baked in; no secret inside). `?origins=` adds the page address of the dashboard.
   * `/package` is the same file for a paired extension updating itself (it names the addresses it already has).
   */
  @Get(['download', 'package'])
  async download(@Req() req: AuthedRequest, @Res() res: Response, @Query('origins') origins?: string) {
    if (!(await this.ext.templateAvailable())) throw new NotFoundException('The extension files are not part of this installation.');
    const extra = String(origins ?? '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 4);
    const list = this.ext.originsFor(requestOrigin(req), extra, Boolean(req.extensionDeviceId));
    const { zip, fileName } = await this.ext.buildZip(list);
    res.setHeader('content-type', 'application/zip');
    res.setHeader('content-disposition', `attachment; filename="${fileName}"`);
    res.setHeader('cache-control', 'no-store');
    res.send(zip);
  }

  /**
   * The dashboard asks for a one-use code (60 s) and hands it to the extension on the page. With a sign-in password set, only a signed-in person can ask
   * (the guard has already checked) and the extension will act as them; without one the server is open anyway and the extension acts as the default operator.
   */
  @Post('pair')
  @HttpCode(200)
  async pair(@Req() req: AuthedRequest) {
    const uid = req.authUserId ?? (this.auth.isConfigured() ? null : (await this.users.defaultOperator()).id);
    if (!uid) throw new UnauthorizedException('Sign in required.');
    return this.ext.pairing.issue(uid);
  }

  /** The extension exchanges the code for its own token. Open (no session): the one-use code is the credential. */
  @Post('token')
  @HttpCode(200)
  async token(@Req() req: Request) {
    const body = (req.body ?? {}) as { code?: unknown; device?: unknown };
    const key = `ext:${req.ip ?? 'unknown'}`;
    const wait = this.limiter.wait(key);
    if (wait > 0) throw new UnauthorizedException(`Too many attempts — wait ${wait} s.`);
    const uid = this.ext.pairing.redeem(body.code);
    if (!uid) {
      this.limiter.fail(key);
      throw new UnauthorizedException('The pairing code is not valid any more — press Connect on the dashboard again.');
    }
    this.limiter.ok(key);
    const device = typeof body.device === 'string' && body.device.trim() ? body.device.trim() : 'Chromium';
    const user = await this.auth.userById(uid);
    if (!user) throw new UnauthorizedException('Could not connect the extension: the person who paired it no longer exists.');
    const { token } = this.devices.add(uid, device);
    return { token, user, serverVersion: this.ext.version };
  }

  /** The extension asks who it is signed in as (and that the token still works). */
  @Get('me')
  async me(@Req() req: AuthedRequest) {
    const user = req.authUserId ? await this.auth.userById(req.authUserId) : null;
    if (!user) throw new UnauthorizedException('Sign in required.');
    return { user, serverVersion: this.ext.version };
  }

  /**
   * «Send to Aigentron»: a page / selection / screenshot becomes a task (or a knowledge-base note) of the chosen project — one call, so the token needs
   * no general task API. The roles are checked inside (a task: task_setter and up; a note: operator and up).
   */
  @Post('clip')
  @HttpCode(200)
  async clip(@Req() req: AuthedRequest, @Body() body: unknown) {
    const user = req.authUserId ? await this.auth.userById(req.authUserId) : null;
    if (!user) throw new UnauthorizedException('Sign in required.');
    return this.clipper.clip(body, user);
  }

  /** The extension disconnects: its own device record is removed. */
  @Post('revoke')
  @HttpCode(200)
  revoke(@Req() req: AuthedRequest) {
    if (req.extensionDeviceId) this.devices.remove(req.extensionDeviceId);
    return { ok: true };
  }

  /** End a paired browser from the dashboard (anyone for their own; a manager for any). */
  @Delete('devices/:id')
  async removeDevice(@Req() req: AuthedRequest, @Param('id') id: string) {
    const d = this.devices.list().find((x) => x.id === id);
    if (!d) throw new NotFoundException('No such browser (it may already be disconnected).');
    const viewer = req.authUserId ? await this.auth.userById(req.authUserId) : null;
    const manager = !this.auth.isConfigured() || viewer?.role === 'operator' || viewer?.role === 'admin';
    if (!manager && d.userId !== viewer?.id) throw new ForbiddenException('You can only disconnect your own browsers.');
    this.devices.remove(id);
    return { ok: true };
  }
}

/** Is a browser's extension older than the one this server ships? (an unknown version never counts as outdated) */
export function isOutdated(installed: string | undefined | null, shipped: string | undefined | null): boolean {
  if (!installed || !shipped || !/^\d/.test(shipped)) return false;
  const a = installed.split('.').map((n) => parseInt(n, 10) || 0);
  const b = shipped.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (b[i] ?? 0) - (a[i] ?? 0);
    if (d) return d > 0;
  }
  return false;
}
