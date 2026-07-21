import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { AppConfigService } from '../config/app-config.service';

/**
 * Guards the hook-facing approval endpoints (check / wait): the caller must
 * present the shared LDS_HOOK_SECRET. Only the PreToolUse hook (which receives
 * the secret in its env) can open or poll approvals — a rogue local process
 * cannot.
 */
@Injectable()
export class HookSecretGuard implements CanActivate {
  constructor(private readonly config: AppConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const provided = req.header('x-lds-hook-secret');
    if (!provided || provided !== this.config.hookSecret) {
      throw new UnauthorizedException('invalid or missing hook secret');
    }
    return true;
  }
}
