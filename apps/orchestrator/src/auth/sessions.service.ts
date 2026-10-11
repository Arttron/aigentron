import { randomBytes } from 'node:crypto';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { describeAgent } from './auth-core';

export interface SessionMeta {
  ip?: string;
  userAgent?: string;
}

export interface SessionView {
  id: string;
  userId: string;
  userName: string;
  role: string;
  device: string;
  ip: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  current: boolean;
}

const TOUCH_EVERY_MS = 5 * 60_000;

/**
 * The list of signed-in browsers / devices. The session cookie itself stays stateless and signed; each one also has a row here so it
 * can be listed and ended individually. Ending one adds its id to an in-memory set that the (synchronous) cookie check consults, so it
 * stops working at once.
 */
@Injectable()
export class SessionsService implements OnModuleInit {
  private readonly logger = new Logger('Sessions');
  private revoked = new Set<string>();
  private touched = new Map<string, number>();

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.prisma.authSession.deleteMany({ where: { expiresAt: { lt: new Date() } } });
      const rows = await this.prisma.authSession.findMany({ where: { revokedAt: { not: null } }, select: { id: true } });
      this.revoked = new Set(rows.map((r) => r.id));
    } catch (e) {
      this.logger.warn(`could not load the session list: ${(e as Error).message}`);
    }
  }

  newId(): string {
    return randomBytes(16).toString('hex');
  }

  isRevoked(sid: string | undefined): boolean {
    return Boolean(sid) && this.revoked.has(sid!);
  }

  /** Remember a freshly issued session (fire-and-forget: the cookie is valid even if this write fails). */
  record(sid: string, userId: string, expiresAt: Date, meta?: SessionMeta): void {
    void this.prisma.authSession
      .create({ data: { id: sid, userId, expiresAt, ip: meta?.ip?.slice(0, 80) ?? null, userAgent: meta?.userAgent?.slice(0, 300) ?? null } })
      .catch((e: Error) => this.logger.warn(`could not record the session: ${e.message}`));
  }

  /** A request was made with this session: note it (at most every 5 minutes per session). */
  touch(sid: string | undefined): void {
    if (!sid) return;
    const now = Date.now();
    if (now - (this.touched.get(sid) ?? 0) < TOUCH_EVERY_MS) return;
    this.touched.set(sid, now);
    if (this.touched.size > 2000) this.touched.delete(this.touched.keys().next().value as string);
    void this.prisma.authSession.updateMany({ where: { id: sid, revokedAt: null }, data: { lastSeenAt: new Date() } }).catch(() => undefined);
  }

  /** A password change / "sign out everywhere" ended every older cookie of this user (or of everybody): drop their rows. */
  async purge(userId?: string): Promise<void> {
    await this.prisma.authSession.deleteMany({ where: userId ? { userId } : {} }).catch(() => undefined);
    if (!userId) this.revoked.clear();
  }

  /**
   * The sessions a person may see: their own, or — for an operator/admin — everybody's. `currentSid` marks the one making the request.
   */
  async list(viewer: { id: string; role: string }, currentSid?: string): Promise<SessionView[]> {
    const manager = viewer.role === 'operator' || viewer.role === 'admin';
    const rows = await this.prisma.authSession.findMany({
      where: { expiresAt: { gt: new Date() }, revokedAt: null, ...(manager ? {} : { userId: viewer.id }) },
      orderBy: { lastSeenAt: 'desc' },
      take: 500,
    });
    const users = await this.prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.userId))] } }, select: { id: true, displayName: true, role: true } });
    const byId = new Map(users.map((u) => [u.id, u]));
    return rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      userName: byId.get(r.userId)?.displayName ?? '(removed user)',
      role: byId.get(r.userId)?.role ?? '',
      device: describeAgent(r.userAgent),
      ip: r.ip,
      createdAt: r.createdAt.toISOString(),
      lastSeenAt: r.lastSeenAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
      current: r.id === currentSid,
    }));
  }

  /** End one session. A person may end their own; an operator/admin anybody's. */
  async revoke(sid: string, viewer: { id: string; role: string }): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
    const row = await this.prisma.authSession.findUnique({ where: { id: sid } });
    if (!row) return { ok: false, error: 'No such session (it may have expired).', status: 404 };
    const manager = viewer.role === 'operator' || viewer.role === 'admin';
    if (row.userId !== viewer.id && !manager) return { ok: false, error: 'You can only end your own sessions.', status: 403 };
    await this.prisma.authSession.update({ where: { id: sid }, data: { revokedAt: new Date() } });
    this.revoked.add(sid);
    return { ok: true };
  }
}
