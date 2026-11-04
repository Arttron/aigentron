import { Body, Controller, Get, HttpException, HttpStatus, Post, Put, Req, UseGuards } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { LoginLimiter } from '../auth/auth-core';
import { RolesGuard } from '../identity/roles.guard';
import { Roles } from '../identity/roles.decorator';
import { IsString, MinLength } from 'class-validator';
import { SettingsService, parseCompression, type SettingsPatch } from './settings.service';
import { normalizeCompression, parseEscalationStep, validRulePattern } from '@lds/shared';
import { UpdateSettingsDto } from './dto/update-settings.dto';
import { AppConfigService } from '../config/app-config.service';
import { machineChatSlots, machineConcurrency } from '../queue/capacity-gate';

class VerifyWizardPasswordDto {
  @IsString()
  @MinLength(1)
  password!: string;
}

type SettingsRow = Awaited<ReturnType<SettingsService['get']>>;

/** Wire-facing settings shape — secrets are masked, never returned in full. */
function serialize(s: SettingsRow) {
  return {
    /** what the queue really uses now (a stored 0 = automatic, resolved for this machine) */
    concurrencyEffective: s.concurrency <= 0 ? machineConcurrency() : s.concurrency,
    chatConcurrency: s.chatConcurrency,
    chatConcurrencyEffective: s.chatConcurrency <= 0 ? machineChatSlots() : s.chatConcurrency,
    approvalTimeoutSeconds: s.approvalTimeoutSeconds,
    verifyCommands: s.verifyCommands ?? '',
    verifyMaxAttempts: s.verifyMaxAttempts,
    concurrency: s.concurrency,
    debugMode: s.debugMode,
    compression: parseCompression(s.compression),
    askModel: s.askModel ?? '',
    agentInstructions: s.agentInstructions,
    defaultProvider: s.defaultProvider,
    defaultAgent: s.defaultAgent,
    notifyChannelId: s.notifyChannelId,
    notifyChatId: s.notifyChatId,
    repoUrl: s.repoUrl,
    repoBranch: s.repoBranch,
    workspaceSubdir: s.workspaceSubdir ?? '',
    updatedAt: s.updatedAt.toISOString(),
    // Secret: report only whether set + a hint, never the value.
    githubTokenSet: Boolean(s.githubToken),
    githubTokenHint: s.githubToken ? `…${s.githubToken.slice(-4)}` : null,
  };
}

/** Map a DTO to a service patch: '' clears nullable fields; undefined leaves them. */
function toPatch(dto: UpdateSettingsDto): SettingsPatch {
  const patch: SettingsPatch = {};
  if (dto.approvalTimeoutSeconds !== undefined)
    patch.approvalTimeoutSeconds = dto.approvalTimeoutSeconds;
  if (dto.verifyCommands !== undefined) patch.verifyCommands = dto.verifyCommands || null;
  if (dto.verifyMaxAttempts !== undefined) patch.verifyMaxAttempts = dto.verifyMaxAttempts;
  if (dto.concurrency !== undefined) patch.concurrency = dto.concurrency;
  if (dto.chatConcurrency !== undefined) patch.chatConcurrency = dto.chatConcurrency;
  if (dto.debugMode !== undefined) patch.debugMode = dto.debugMode;
  if (dto.askModel !== undefined) {
    const v = dto.askModel.trim();
    if (v && !parseEscalationStep(v)) throw new HttpException('The question model must be written provider/model', HttpStatus.BAD_REQUEST);
    patch.askModel = v || null;
  }
  if (dto.compression !== undefined) {
    const c = normalizeCompression(dto.compression);
    for (const r of c.rules) {
      const bad = validRulePattern(r.pattern, r.flags);
      if (bad) throw new HttpException(`Rule "${r.name}": ${bad}`, HttpStatus.BAD_REQUEST);
    }
    patch.compression = JSON.stringify(c);
  }
  if (dto.agentInstructions !== undefined) patch.agentInstructions = dto.agentInstructions;
  if (dto.defaultProvider !== undefined) patch.defaultProvider = dto.defaultProvider || null;
  if (dto.defaultAgent !== undefined) patch.defaultAgent = dto.defaultAgent || null;
  if (dto.repoUrl !== undefined) patch.repoUrl = dto.repoUrl || null;
  if (dto.repoBranch !== undefined) patch.repoBranch = dto.repoBranch || 'main';
  if (dto.workspaceSubdir !== undefined) patch.workspaceSubdir = dto.workspaceSubdir || null;
  if (dto.githubToken !== undefined) patch.githubToken = dto.githubToken || null;
  if (dto.notifyChannelId !== undefined) patch.notifyChannelId = dto.notifyChannelId || null;
  if (dto.notifyChatId !== undefined) patch.notifyChatId = dto.notifyChatId || null;
  return patch;
}

@Controller('settings')
export class SettingsController {
  private readonly limiter = new LoginLimiter();

  constructor(
    private readonly settings: SettingsService,
    private readonly config: AppConfigService,
  ) {}

  @Get()
  async get() {
    return serialize(await this.settings.get());
  }

  @UseGuards(RolesGuard)
  @Roles('operator', 'admin')
  @Put()
  async update(@Body() dto: UpdateSettingsDto) {
    return serialize(await this.settings.update(toPatch(dto)));
  }

  /**
   * Gates infra/setup-wizard.mjs's "advanced" mode. A local confirmation
   * speed bump (mirrors hook-secret.guard.ts's shared-secret-from-env
   * pattern), not a security boundary — v1 has no auth anywhere else either.
   */
  @UseGuards(RolesGuard)
  @Roles('operator', 'admin')
  @Post('verify-wizard-password')
  verifyWizardPassword(@Body() dto: VerifyWizardPasswordDto, @Req() req: Request) {
    if (!this.config.wizardAdminPassword) {
      return { ok: false, error: 'WIZARD_ADMIN_PASSWORD is not configured on the server' };
    }
    const key = req.socket?.remoteAddress ?? 'unknown';
    const wait = this.limiter.wait(key);
    if (wait > 0) throw new HttpException(`Too many attempts, retry in ${wait}s`, HttpStatus.TOO_MANY_REQUESTS);
    const a = Buffer.from(dto.password);
    const b = Buffer.from(this.config.wizardAdminPassword);
    const ok = a.length === b.length && timingSafeEqual(a, b);
    if (ok) this.limiter.ok(key);
    else this.limiter.fail(key);
    return { ok };
  }
}
