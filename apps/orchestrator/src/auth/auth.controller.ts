import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { lookup } from 'node:dns/promises';
import { SESSION_COOKIE, clientAddress } from './auth-core';
import { publicOrigin } from '../config/cors';
import { RolesGuard } from '../identity/roles.guard';
import { Roles } from '../identity/roles.decorator';

type AuthedRequest = Request & { authUserId?: string };

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  private trusted: { at: number; ips: string[] } = { at: 0, ips: [] };

  /** Peers whose `cf-connecting-ip` we believe: TRUSTED_PROXY (comma list) plus the `cloudflared` container of the compose stack. */
  private async trustedPeers(): Promise<string[]> {
    if (Date.now() - this.trusted.at < 60_000) return this.trusted.ips;
    const fromEnv = (process.env.TRUSTED_PROXY ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    const resolved = await lookup('cloudflared', { all: true }).then((r) => r.map((x) => x.address)).catch(() => []);
    this.trusted = { at: Date.now(), ips: [...fromEnv, ...resolved] };
    return this.trusted.ips;
  }

  private async clientKey(req: Request): Promise<string> {
    const cf = req.headers['cf-connecting-ip'];
    return clientAddress(Array.isArray(cf) ? cf[0] : cf, req.socket.remoteAddress || 'unknown', await this.trustedPeers());
  }

  private setCookie(req: Request, res: Response, token: string): void {
    const https = req.secure || req.headers['x-forwarded-proto'] === 'https' || (publicOrigin(process.env.PUBLIC_URL) ?? '').startsWith('https:');
    const days = this.auth.sessionDays();
    res.append(
      'Set-Cookie',
      `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${days * 86400}${https ? '; Secure' : ''}`,
    );
  }

  @Get('status')
  async status(@Req() req: Request) {
    const configured = this.auth.isConfigured();
    const uid = this.auth.sessionUserId(req.headers);
    return {
      configured,
      authenticated: uid !== null,
      publicUrl: Boolean(publicOrigin(process.env.PUBLIC_URL)),
      // The login screen lists who can sign in (names only) — pick one, type the password.
      users: configured && !uid ? await this.auth.loginUsers() : [],
      me: uid ? await this.auth.userById(uid) : null,
    };
  }

  @Post('setup')
  @HttpCode(200)
  async setup(@Body() body: { password?: unknown }, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const r = await this.auth.setup(body?.password);
    if (!r.ok) {
      res.status(r.status ?? 400);
      return { ok: false, error: r.error };
    }
    this.setCookie(req, res, r.token);
    return { ok: true };
  }

  @Post('login')
  @HttpCode(200)
  async login(@Body() body: { user?: unknown; password?: unknown }, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const r = await this.auth.login(body?.user, body?.password, await this.clientKey(req));
    if (!r.ok) {
      res.status(r.status ?? 401);
      return { ok: false, error: r.error };
    }
    this.setCookie(req, res, r.token);
    // The token is also returned so the console client can use it as a bearer token.
    return { ok: true, token: r.token };
  }

  @Post('logout')
  @HttpCode(200)
  logout(@Res({ passthrough: true }) res: Response) {
    res.append('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    return { ok: true };
  }

  /** Change YOUR password. */
  @Post('password')
  @HttpCode(200)
  async password(@Body() body: { current?: unknown; next?: unknown }, @Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response) {
    if (!req.authUserId) {
      res.status(400);
      return { ok: false, error: 'Sign in first.' };
    }
    const r = await this.auth.changeOwnPassword(req.authUserId, body?.current, body?.next, await this.clientKey(req));
    if (!r.ok) {
      res.status(r.status ?? 400);
      return { ok: false, error: r.error };
    }
    this.setCookie(req, res, r.token);
    return { ok: true };
  }

  @Post('sign-out-everywhere')
  @HttpCode(200)
  signOutEverywhere(@Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response) {
    const r = req.authUserId ? this.auth.signOutEverywhere(req.authUserId) : null;
    if (r) this.setCookie(req, res, r.token); // keep THIS browser signed in
    return { ok: true };
  }

  /** Managers: who has a password. */
  @Get('passwords')
  @UseGuards(RolesGuard)
  @Roles('operator', 'admin')
  passwords() {
    return this.auth.passwordOverview();
  }

  /** Managers: set or reset someone's password (that person is signed out everywhere). */
  @Put('users/:id/password')
  @UseGuards(RolesGuard)
  @Roles('operator', 'admin')
  async setUserPassword(@Param('id') id: string, @Body() body: { password?: unknown }, @Res({ passthrough: true }) res: Response) {
    const r = await this.auth.setUserPassword(id, body?.password);
    if (!r.ok) {
      res.status(r.status ?? 400);
      return { ok: false, error: r.error };
    }
    return { ok: true };
  }

  /** Managers: take someone's password away (they can no longer sign in). */
  @Delete('users/:id/password')
  @UseGuards(RolesGuard)
  @Roles('operator', 'admin')
  async removeUserPassword(@Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    const r = await this.auth.removeUserPassword(id);
    if (!r.ok) {
      res.status(r.status ?? 400);
      return { ok: false, error: r.error };
    }
    return { ok: true };
  }
}
