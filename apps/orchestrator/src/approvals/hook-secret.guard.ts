import { timingSafeEqual } from 'node:crypto';
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
    if (!provided || !sameSecret(provided, this.config.hookSecret)) {
      throw new UnauthorizedException('invalid or missing hook secret');
    }
    return true;
  }
}

/** Equal without leaking, by timing, how much of the secret was right. */
function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
