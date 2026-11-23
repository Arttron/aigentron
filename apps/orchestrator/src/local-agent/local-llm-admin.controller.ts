import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from '../auth/auth.service';
import { ProvidersService } from '../providers/providers.service';
import { LocalLlmService } from './local-llm.service';

const PROVIDER = 'local-llm';

/** What the Local agent tab shows about shared models, and the one button that turns them into a provider (operators and admins). */
@Controller('local-agent/llm')
export class LocalLlmAdminController {
  constructor(
    private readonly auth: AuthService,
    private readonly llm: LocalLlmService,
    private readonly providers: ProvidersService,
  ) {}

  private async requireManager(req: Request & { authUserId?: string }): Promise<void> {
    const viewer = req.authUserId ? await this.auth.userById(req.authUserId) : null;
    if (this.auth.isConfigured() && viewer?.role !== 'operator' && viewer?.role !== 'admin') throw new ForbiddenException('Only an operator or an admin can use this.');
  }

  @Get()
  async info(@Req() req: Request & { authUserId?: string }) {
    await this.requireManager(req);
    const models = await this.llm.shared();
    const existing = await this.providers.get(PROVIDER).catch(() => null);
    return { baseUrl: this.llm.baseUrl(), models, provider: existing ? { name: PROVIDER, model: existing.model } : null };
  }

  /** Create (or re-point) the provider `local-llm` at this endpoint for a chosen shared model; agents then pick it like any provider. */
  @Post('provider')
  @HttpCode(200)
  async provider(@Req() req: Request & { authUserId?: string }, @Body() body: { model?: unknown; baseUrl?: unknown }) {
    await this.requireManager(req);
    if (typeof body?.model !== 'string' || !body.model) throw new BadRequestException('model is required');
    const baseUrl = typeof body.baseUrl === 'string' && /^https?:\/\//.test(body.baseUrl) ? body.baseUrl.replace(/\/$/, '') : this.llm.baseUrl();
    const patch = { kind: 'openai', baseUrl, model: body.model, authMode: 'api-key' as const, secret: this.llm.key() };
    const exists = await this.providers.get(PROVIDER).then(() => true, () => false);
    if (exists) await this.providers.update(PROVIDER, patch);
    else await this.providers.create({ name: PROVIDER, ...patch });
    return { name: PROVIDER, model: body.model, baseUrl };
  }
}
