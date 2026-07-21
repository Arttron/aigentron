import { SetMetadata } from '@nestjs/common';
import type { UserRole } from '@lds/shared';

export const ROLES_KEY = 'roles';

/**
 * Restrict a route to the given roles. The RolesGuard resolves the acting user
 * and rejects anyone whose role is not in the list. Absent → any resolved user.
 */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
