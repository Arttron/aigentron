import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { UserRow } from '../users/users.service';

/**
 * Injects the acting user resolved by the RolesGuard. Only meaningful on routes
 * guarded by RolesGuard (otherwise `req.user` is unset → undefined).
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): UserRow | undefined => {
    const req = ctx.switchToHttp().getRequest<{ user?: UserRow }>();
    return req.user;
  },
);
