import { describe, expect, it } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';
import { ROLES_KEY } from './roles.decorator';

const users: Record<string, { id: string; role: string }> = {
  op: { id: 'op', role: 'operator' },
  rev: { id: 'rev', role: 'reviewer' },
  ts: { id: 'ts', role: 'task_setter' },
};
const usersSvc = {
  getRow: async (id: string) => {
    if (!users[id]) throw new Error('nope');
    return users[id];
  },
  defaultOperator: async () => users.op,
};

function run(required: string[] | undefined, req: Record<string, unknown>) {
  const reflector = { getAllAndOverride: () => required } as unknown as Reflector;
  const guard = new RolesGuard(reflector, usersSvc as never);
  const ctx = {
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => req }),
  };
  return guard.canActivate(ctx as never).then(() => req as { user?: { id: string } });
}

describe('RolesGuard', () => {
  it('uses the metadata key "roles"', () => expect(ROLES_KEY).toBe('roles'));

  it('no header and no session -> default operator, allowed on operator routes', async () => {
    expect((await run(['operator', 'admin'], { headers: {} })).user?.id).toBe('op');
  });
  it('a route without roles lets any resolved user through', async () => {
    expect((await run(undefined, { headers: { 'x-lds-user': 'rev' } })).user?.id).toBe('rev');
  });
  it('x-lds-user selects the acting user when there is no session', async () => {
    await expect(run(['operator', 'admin'], { headers: { 'x-lds-user': 'rev' } })).rejects.toBeInstanceOf(ForbiddenException);
    expect((await run(['task_setter', 'operator'], { headers: { 'x-lds-user': 'ts' } })).user?.id).toBe('ts');
  });
  it('an unknown x-lds-user is 403', async () => {
    await expect(run(undefined, { headers: { 'x-lds-user': 'ghost' } })).rejects.toBeInstanceOf(ForbiddenException);
  });
  it('the session wins over a spoofed x-lds-user header', async () => {
    await expect(run(['operator', 'admin'], { headers: { 'x-lds-user': 'op' }, authUserId: 'rev' })).rejects.toBeInstanceOf(ForbiddenException);
    expect((await run(['operator'], { headers: { 'x-lds-user': 'rev' }, authUserId: 'op' })).user?.id).toBe('op');
  });
  it('a session of a deleted account is 403', async () => {
    await expect(run(undefined, { headers: {}, authUserId: 'gone' })).rejects.toBeInstanceOf(ForbiddenException);
  });
});
