import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, HttpCode, NotFoundException, Param, Post, Put, Query, Req, Res, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthService } from '../auth/auth.service';
import { LoginLimiter } from '../auth/auth-core';
import { UsersService } from '../users/users.service';
import { PairingCodes } from '../extension/extension-pairing';
import { DeviceFlow } from './device-flow';
import { installScript, safeOrigin } from './install-script';
import { LocalAgentPackageService } from './local-agent-package.service';
import { LocalBridgeService } from './local-bridge.service';
import { LocalDevicesService } from './local-devices.service';
import { LocalRulesService } from './local-rules.service';
import { LocalBindingsService } from './local-bindings.service';
import { DEFAULT_RULES, RULE_NAMES } from './local-rules';

type AuthedRequest = Request & { authUserId?: string };

/** The origin this request came to (behind a proxy: from the forwarded headers). */
function requestOrigin(req: Request): string | null {
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.split(',')[0]?.trim();
  const proto = first(req.headers['x-forwarded-proto']) || req.protocol || 'http';
  const host = first(req.headers['x-forwarded-host']) || req.headers.host;
  const o = host ? `${proto}://${host}` : null;
  return o && safeOrigin(o) ? o : null;
}

/** Is a daemon older than the server? Versions of the two move together (the daemon is released with the server). */
export const localOutdated = (installed: string | undefined, server: string): boolean => Boolean(installed) && /^\d/.test(server) && installed !== server;

@Controller('local-agent')
export class LocalAgentController {
  private readonly flow = new DeviceFlow(10 * 60_000, 2);
  /** the fallback for a machine with no browser: a code typed into `aigentron-local pair` (long enough to finish an install) */
  private readonly pairing = new PairingCodes(10 * 60_000);
  private readonly limiter = new LoginLimiter(10);
  private readonly starts = new Map<string, number[]>();

  constructor(
    private readonly auth: AuthService,
    private readonly users: UsersService,
    private readonly devices: LocalDevicesService,
    private readonly bridge: LocalBridgeService,
    private readonly pkg: LocalAgentPackageService,
    private readonly rules: LocalRulesService,
    private readonly bindings: LocalBindingsService,
  ) {}

  private async actingUser(req: AuthedRequest): Promise<string> {
    const uid = req.authUserId ?? (this.auth.isConfigured() ? null : (await this.users.defaultOperator()).id);
    if (!uid) throw new UnauthorizedException('Sign in required.');
    return uid;
  }

  private async isManager(req: AuthedRequest): Promise<{ manager: boolean; viewerId?: string }> {
    const viewer = req.authUserId ? await this.auth.userById(req.authUserId) : null;
    return { manager: !this.auth.isConfigured() || viewer?.role === 'operator' || viewer?.role === 'admin', viewerId: viewer?.id };
  }

  /** What Add-ons → Local agent shows: the devices paired with this server and whether each is online. */
  @Get('info')
  async info(@Req() req: AuthedRequest) {
    const { manager, viewerId } = await this.isManager(req);
    const names = new Map((await this.users.list()).map((u) => [u.id, u.displayName]));
    const version = this.bridge.version;
    const devices = this.devices
      .list()
      .filter((d) => manager || d.userId === viewerId)
      .map((d) => {
        const live = this.bridge.connection(d.id);
        return {
          id: d.id,
          label: d.label,
          user: names.get(d.userId) ?? '(removed user)',
          os: live?.os ?? d.os ?? null,
          arch: live?.arch ?? d.arch ?? null,
          host: live?.host ?? d.host ?? null,
          version: live?.version ?? d.version ?? null,
          createdAt: d.createdAt,
          lastSeenAt: live ? new Date().toISOString() : d.lastSeenAt,
          online: Boolean(live),
          rulesRev: live?.configRev ?? null,
          // the repositories the computer allowed (agents can read these once a project is bound to one); the list of changed files is cut for the overview
          repos: this.bridge.repos(d.id).map((r) => ({ ...r, files: r.files.slice(0, 20) })),
          outdated: localOutdated(live?.version ?? d.version, version),
        };
      });
    const visible = new Set(devices.map((d) => d.id));
    const bindings = (await this.bindings.view()).filter((b) => visible.has(b.deviceId));
    return { version, signInOn: this.auth.isConfigured(), rulesRev: this.rules.get().rev, devices, bindings };
  }

  /** «This project's agents may read this repository on this computer» — the person's consent. Only while the repository's origin is the project's repository. */
  @Post('bindings')
  @HttpCode(200)
  async bind(@Req() req: AuthedRequest, @Body() body: { projectId?: unknown; deviceId?: unknown; repoId?: unknown }) {
    const { manager, viewerId } = await this.isManager(req);
    const dev = this.devices.list().find((d) => d.id === body?.deviceId);
    if (!dev) throw new NotFoundException('No such computer.');
    if (!manager && dev.userId !== viewerId) throw new ForbiddenException('You can only share your own computers.');
    if (typeof body?.projectId !== 'string' || typeof body?.repoId !== 'string') throw new BadRequestException('projectId and repoId are required.');
    const r = await this.bindings.create({ projectId: body.projectId, deviceId: dev.id, repoId: body.repoId }, await this.actingUser(req));
    if (!r.ok) throw new BadRequestException(r.error);
    return r.binding;
  }

  @Delete('bindings/:id')
  async unbind(@Req() req: AuthedRequest, @Param('id') id: string) {
    const b = this.bindings.list().find((x) => x.id === id);
    if (!b) throw new NotFoundException('No such binding.');
    const { manager, viewerId } = await this.isManager(req);
    const dev = this.devices.list().find((d) => d.id === b.deviceId);
    if (!manager && dev?.userId !== viewerId) throw new ForbiddenException('You can only stop sharing your own computers.');
    this.bindings.remove(id);
    return { ok: true };
  }

  /** The global rules (what the tab edits) with the defaults and the rule names the form needs. */
  @Get('rules')
  getRules() {
    const { rev, rules } = this.rules.get();
    return { rev, rules, defaults: DEFAULT_RULES, ruleNames: RULE_NAMES };
  }

  /** Save the global rules (managers only); they reach the online computers at once and the others when they connect. */
  @Put('rules')
  async putRules(@Req() req: AuthedRequest, @Body() body: { rules?: unknown }) {
    const { manager } = await this.isManager(req);
    if (!manager) throw new ForbiddenException('Only an operator or an admin can change the rules.');
    const r = await this.rules.set(body?.rules);
    if (!r.ok) throw new BadRequestException(r.error);
    return { rev: r.rev, rules: r.rules };
  }

  /** The daemon starts the sign-in: two codes back (the long one stays with the daemon, the short one is shown to the person). Open; rate-limited by address. */
  @Post('device/start')
  @HttpCode(200)
  start(@Req() req: Request, @Body() body: unknown) {
    const key = req.ip ?? 'unknown';
    const now = Date.now();
    const recent = (this.starts.get(key) ?? []).filter((t) => now - t < 10 * 60_000);
    if (recent.length >= 20) throw new UnauthorizedException('Too many sign-in attempts — wait a few minutes.');
    this.starts.set(key, [...recent, now]);
    if (this.starts.size > 500) this.starts.delete(this.starts.keys().next().value as string);
    const s = this.flow.start((body ?? {}) as Record<string, unknown>);
    const origin = requestOrigin(req);
    return { ...s, verificationUrl: origin ? `${origin}/addons?tab=local-agent&code=${s.userCode}` : null };
  }

  /** The daemon asks whether the person has decided. Open: the long code is the credential. */
  @Post('device/poll')
  @HttpCode(200)
  async poll(@Body() body: unknown) {
    const r = this.flow.poll((body as { deviceCode?: unknown } | undefined)?.deviceCode);
    if (r.status !== 'approved') return { status: r.status };
    const { token } = this.devices.add(r.uid, r.info.device, r.info);
    const user = await this.auth.userById(r.uid);
    return { status: 'approved', token, user, serverVersion: this.bridge.version };
  }

  /** The person opens the link: what is asking to be connected? */
  @Get('device/lookup')
  lookup(@Query('code') code?: string) {
    const d = this.flow.describe(code);
    if (!d) throw new NotFoundException('This code is not valid any more — start the sign-in on the computer again.');
    return d;
  }

  /** The signed-in person approves or denies. */
  @Post('device/approve')
  @HttpCode(200)
  async approve(@Req() req: AuthedRequest, @Body() body: { code?: unknown; approve?: unknown }) {
    const uid = await this.actingUser(req);
    if (!this.flow.decide(body?.code, uid, body?.approve !== false)) throw new NotFoundException('This code is not valid any more — start the sign-in on the computer again.');
    return { ok: true };
  }

  /** Fallback for a machine without a browser: a one-use code to type into `aigentron-local pair`. */
  @Post('pair')
  @HttpCode(200)
  async pair(@Req() req: AuthedRequest) {
    return this.pairing.issue(await this.actingUser(req));
  }

  /** Exchange that code for a device token. Open: the one-use code is the credential. */
  @Post('token')
  @HttpCode(200)
  async token(@Req() req: Request, @Body() body: { code?: unknown; device?: unknown; os?: unknown; arch?: unknown; version?: unknown }) {
    const key = `lag:${req.ip ?? 'unknown'}`;
    const wait = this.limiter.wait(key);
    if (wait > 0) throw new UnauthorizedException(`Too many attempts — wait ${wait} s.`);
    const uid = this.pairing.redeem(body?.code);
    if (!uid) {
      this.limiter.fail(key);
      throw new UnauthorizedException('The pairing code is not valid any more — create a new one on the dashboard.');
    }
    this.limiter.ok(key);
    const user = await this.auth.userById(uid);
    if (!user) throw new UnauthorizedException('The person who created this code no longer exists.');
    const label = typeof body?.device === 'string' && body.device.trim() ? body.device : 'Computer';
    const { token } = this.devices.add(uid, label, body ?? {});
    return { token, user, serverVersion: this.bridge.version };
  }

  /** Disconnect a computer (anyone for their own; a manager for any). Its open connection is told and closed. */
  @Delete('devices/:id')
  async remove(@Req() req: AuthedRequest, @Param('id') id: string) {
    const d = this.devices.list().find((x) => x.id === id);
    if (!d) throw new NotFoundException('No such device (it may already be disconnected).');
    const { manager, viewerId } = await this.isManager(req);
    if (!manager && d.userId !== viewerId) throw new ForbiddenException('You can only disconnect your own computers.');
    this.devices.remove(id);
    this.bindings.removeForDevice(id);
    this.bridge.revoke(id);
    return { ok: true };
  }

  /** `curl -fsSL <server>/api/local-agent/install.sh | sh`. Open (it holds no secret). */
  @Get('install.sh')
  installSh(@Req() req: Request, @Res() res: Response) {
    const origin = requestOrigin(req);
    if (!origin) throw new NotFoundException('Cannot tell this server\'s address.');
    res.type('text/x-shellscript').setHeader('cache-control', 'no-store').send(installScript(origin));
  }

  /** The archive for a platform (this server's version, checked against the release). Open: the release is public. */
  @Get('package')
  async package(@Query('os') os: string, @Query('arch') arch: string, @Res() res: Response) {
    const p = await this.pkg.get(String(os), String(arch));
    res.setHeader('content-disposition', `attachment; filename="${p.name}"`);
    res.setHeader('x-sha256', p.sha256);
    res.sendFile(p.file);
  }

  @Get('package.sha256')
  async packageSha(@Query('os') os: string, @Query('arch') arch: string, @Res() res: Response) {
    res.type('text/plain').send(`${(await this.pkg.get(String(os), String(arch))).sha256}\n`);
  }
}
