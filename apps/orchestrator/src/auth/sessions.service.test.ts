import { describe, expect, it, vi } from 'vitest';
import { SessionsService } from './sessions.service';

type Row = { id: string; userId: string; createdAt: Date; lastSeenAt: Date; expiresAt: Date; ip: string | null; userAgent: string | null; revokedAt: Date | null };

function env() {
  const now = new Date();
  const later = new Date(Date.now() + 86_400_000);
  const rows: Row[] = [
    { id: 'a1', userId: 'op', createdAt: now, lastSeenAt: now, expiresAt: later, ip: '1.1.1.1', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/126.0 Safari/537.36', revokedAt: null },
    { id: 'b2', userId: 'tester', createdAt: now, lastSeenAt: now, expiresAt: later, ip: '2.2.2.2', userAgent: 'curl/8', revokedAt: null },
    { id: 'c3', userId: 'tester', createdAt: now, lastSeenAt: now, expiresAt: new Date(Date.now() - 1000), ip: null, userAgent: null, revokedAt: null },
  ];
  const prisma = {
    authSession: {
      findMany: vi.fn(async ({ where }: { where: { userId?: string; expiresAt?: { gt: Date }; revokedAt?: null } }) =>
        rows.filter((r) => (!where.userId || r.userId === where.userId) && (!where.expiresAt || r.expiresAt > where.expiresAt.gt) && (where.revokedAt === undefined || r.revokedAt === null)),
      ),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id) ?? null),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => Object.assign(rows.find((r) => r.id === where.id)!, data)),
    },
    user: { findMany: vi.fn(async () => [{ id: 'op', displayName: 'Operator', role: 'operator' }, { id: 'tester', displayName: 'Tester', role: 'reviewer' }]) },
  };
  return { svc: new SessionsService(prisma as never), rows };
}

describe('SessionsService', () => {
  it('a person sees their own sessions; an operator / admin sees everybody\'s; expired ones are hidden', async () => {
    const { svc } = env();
    expect((await svc.list({ id: 'tester', role: 'reviewer' })).map((s) => s.id)).toEqual(['b2']);
    const all = await svc.list({ id: 'op', role: 'operator' }, 'a1');
    expect(all.map((s) => s.id).sort()).toEqual(['a1', 'b2']);
    expect(all.find((s) => s.id === 'a1')).toMatchObject({ current: true, userName: 'Operator', device: 'Chrome on macOS' });
  });
  it('a person can end only their own session; a manager anybody\'s; an ended session stops working at once', async () => {
    const { svc } = env();
    expect(await svc.revoke('a1', { id: 'tester', role: 'reviewer' })).toMatchObject({ ok: false, status: 403 });
    expect(svc.isRevoked('a1')).toBe(false);
    expect(await svc.revoke('b2', { id: 'tester', role: 'reviewer' })).toEqual({ ok: true });
    expect(svc.isRevoked('b2')).toBe(true);
    expect(await svc.revoke('a1', { id: 'op', role: 'operator' })).toEqual({ ok: true });
    expect(svc.isRevoked('a1')).toBe(true);
    expect(await svc.revoke('nope', { id: 'op', role: 'operator' })).toMatchObject({ ok: false, status: 404 });
    expect(svc.isRevoked(undefined)).toBe(false);
  });
});
