import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { SESSION_COOKIE, type ClientId } from './auth-core';
import { publicOrigin } from '../config/cors';
import { RolesGuard } from '../identity/roles.guard';
import { Roles } from '../identity/roles.decorator';

type AuthedRequest = Request & { authUserId?: string };

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  private clientKey(req: Request): ClientId {
    // Behind a tunnel the peer is always the connector; Cloudflare puts the real client in cf-connecting-ip. That header can be forged
    // by anyone connecting directly, so the peer address is counted too (see SignInGuard).
    const cf = req.headers['cf-connecting-ip'];
    const peer = req.socket.remoteAddress || 'unknown';
    return { client: (Array.isArray(cf) ? cf[0] : cf) || peer, peer };
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
    const r = await this.auth.login(body?.user, body?.password, this.clientKey(req));
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
    const r = await this.auth.changeOwnPassword(req.authUserId, body?.current, body?.next, this.clientKey(req));
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
