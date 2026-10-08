import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { UserRole } from '@lds/shared';
import { UsersService, type UserRow } from '../users/users.service';
import { ROLES_KEY } from './roles.decorator';

/**
 * Resolves the acting user for a request and enforces `@Roles(...)`.
 *
 * Identity: with sign-in on, the session's user acts. Without it, the `x-lds-user` header carries a User id. When
 * present it must resolve to a known user (else 403); when absent the request
 * is attributed to the default operator. The resolved user is attached as
 * `req.user` for `@CurrentUser()`. If the route declares roles, the user's role
 * must be among them.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly users: UsersService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
      user?: UserRow;
      authUserId?: string;
    }>();

    const raw = req.headers['x-lds-user'];
    const userId = (Array.isArray(raw) ? raw[0] : raw)?.trim();

    let user: UserRow;
    if (req.authUserId) {
      // Signed in: the session decides who acts (a header can't make you someone else).
      try {
        user = await this.users.getRow(req.authUserId);
      } catch {
        throw new ForbiddenException('Your account no longer exists');
      }
    } else if (userId) {
      try {
        user = await this.users.getRow(userId);
      } catch {
        throw new ForbiddenException('Unknown acting user');
      }
    } else {
      user = await this.users.defaultOperator();
    }
    req.user = user;

    const required = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    if (!required.includes(user.role as UserRole)) {
      throw new ForbiddenException(
        `Requires role: ${required.join(' | ')} (you are ${user.role})`,
      );
    }
    return true;
  }
}
