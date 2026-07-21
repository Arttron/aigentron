import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { ChannelKind, UserRole } from '@lds/shared';
import { PrismaService } from '../prisma/prisma.service';

/** Prisma user row with its channel identities. */
export type UserRow = NonNullable<
  Awaited<ReturnType<UsersService['getRow']>>
>;

export interface UserPatch {
  displayName?: string;
  role?: UserRole;
  identities?: { channel: ChannelKind; externalId: string }[];
}

/**
 * Registry of human participants. Not an auth system (no credentials in v1) —
 * the acting user is resolved from a request header and defaults to the seeded
 * operator. This is the identity foundation channels/human-agents build on.
 */
@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Seed a single operator on first use, so there is always a valid actor. */
  private async ensureSeeded(): Promise<void> {
    if ((await this.prisma.user.count()) > 0) return;
    await this.prisma.user.create({
      data: { displayName: 'Operator', role: 'operator' },
    });
    this.logger.log('Seeded default operator user');
  }

  async list() {
    await this.ensureSeeded();
    return this.prisma.user.findMany({
      orderBy: { createdAt: 'asc' },
      include: { identities: { orderBy: { channel: 'asc' } } },
    });
  }

  /** Fetch a user by id (with identities); 404 if missing. */
  async getRow(id: string) {
    const row = await this.prisma.user.findUnique({
      where: { id },
      include: { identities: { orderBy: { channel: 'asc' } } },
    });
    if (!row) throw new NotFoundException(`User ${id} not found`);
    return row;
  }

  /**
   * The user to attribute an action to when no explicit actor is supplied.
   * Prefers an operator/admin, else the earliest-created user.
   */
  async defaultOperator(): Promise<UserRow> {
    await this.ensureSeeded();
    const privileged = await this.prisma.user.findFirst({
      where: { role: { in: ['operator', 'admin'] } },
      orderBy: { createdAt: 'asc' },
      include: { identities: true },
    });
    if (privileged) return privileged;
    const first = await this.prisma.user.findFirst({
      orderBy: { createdAt: 'asc' },
      include: { identities: true },
    });
    // ensureSeeded guarantees at least one user exists.
    return first as UserRow;
  }

  /** Resolve a user by one of their channel identities (used by channel adapters). */
  async resolveByIdentity(channel: ChannelKind, externalId: string): Promise<UserRow | null> {
    const identity = await this.prisma.channelIdentity.findUnique({
      where: { channel_externalId: { channel, externalId } },
      include: { user: { include: { identities: true } } },
    });
    return identity?.user ?? null;
  }

  async create(input: {
    displayName: string;
    role?: UserRole;
    identities?: { channel: ChannelKind; externalId: string }[];
  }): Promise<UserRow> {
    const user = await this.prisma.user.create({
      data: {
        displayName: input.displayName.trim(),
        role: input.role ?? 'task_setter',
        identities: input.identities?.length
          ? { create: input.identities.map((i) => ({ channel: i.channel, externalId: i.externalId })) }
          : undefined,
      },
      include: { identities: true },
    });
    this.logger.log(`Created user ${user.id} (${user.displayName}, ${user.role})`);
    return user;
  }

  async update(id: string, patch: UserPatch): Promise<UserRow> {
    await this.getRow(id); // 404 if missing
    // Identities are replaced wholesale when provided (simplest predictable semantics).
    return this.prisma.user.update({
      where: { id },
      data: {
        ...(patch.displayName !== undefined ? { displayName: patch.displayName.trim() } : {}),
        ...(patch.role !== undefined ? { role: patch.role } : {}),
        ...(patch.identities !== undefined
          ? {
              identities: {
                deleteMany: {},
                create: patch.identities.map((i) => ({ channel: i.channel, externalId: i.externalId })),
              },
            }
          : {}),
      },
      include: { identities: true },
    });
  }

  async remove(id: string): Promise<void> {
    await this.getRow(id); // 404 if missing
    // FK onDelete: identities cascade; Task.createdById / ApprovalRequest.resolvedById set null.
    await this.prisma.user.delete({ where: { id } });
    this.logger.log(`Deleted user ${id}`);
  }
}
