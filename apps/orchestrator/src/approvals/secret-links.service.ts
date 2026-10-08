import { randomBytes } from 'node:crypto';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { REQUEST_SECRET_TOOL } from '@lds/shared';
import { publicOrigin } from '../config/cors';
import { ApprovalsService } from './approvals.service';

const TTL_MS = 10 * 60_000;
const MAX_ATTEMPTS = 5;

/** What a secret request is asking for, in words (shown on the card, the secure page and in chat messages). */
export function secretLabel(input: { target?: string; name?: string }): string {
  if (input.target === 'provider') return `API key / token for the provider "${input.name ?? '?'}"`;
  if (input.target === 'github_token') return 'GitHub token';
  if (input.target === 'channel') return `bot token for the channel "${input.name ?? '?'}"`;
  return 'a secret';
}

interface Link {
  approvalId: string;
  expiresAt: number;
  attempts: number;
}

/**
 * One-time links for entering a secret from a device where the dashboard is not open — typically a phone, right after a
 * Telegram message from the admin. The link only lets the holder SET the value requested by one pending request_secret
 * approval (write-only; nothing can be read through it), works once, and expires in 10 minutes. It exists only in memory.
 * The value never goes through the chat or the model — the page posts it straight to this server.
 */
@Injectable()
export class SecretLinksService {
  private readonly links = new Map<string, Link>();

  constructor(private readonly approvals: ApprovalsService) {}

  /** The public base address, when one is configured (PUBLIC_URL) — without it no link can be offered. */
  base(): string | null {
    return publicOrigin(process.env.PUBLIC_URL);
  }

  /** A fresh link for a pending secret request, or null when there is no public address to point at. */
  create(approvalId: string, now = Date.now()): string | null {
    const base = this.base();
    if (!base) return null;
    this.sweep(now);
    const token = randomBytes(32).toString('base64url');
    this.links.set(token, { approvalId, expiresAt: now + TTL_MS, attempts: 0 });
    return `${base}/secret/${token}`;
  }

  private sweep(now: number): void {
    for (const [t, l] of this.links) if (l.expiresAt <= now) this.links.delete(t);
    if (this.links.size > 200) this.links.delete(this.links.keys().next().value as string);
  }

  private find(token: string, now = Date.now()): Link {
    const l = this.links.get(token);
    if (!l || l.expiresAt <= now) {
      this.links.delete(token);
      throw new NotFoundException('This link has expired or was already used. Ask the assistant to request it again.');
    }
    return l;
  }

  /** What the page shows: what is being asked for, and for how long. Throws when the link is dead. */
  async peek(token: string, now = Date.now()): Promise<{ label: string; reason: string; expiresInSec: number }> {
    const l = this.find(token, now);
    const a = await this.approvals.get(l.approvalId).catch(() => null);
    if (!a || a.toolName !== REQUEST_SECRET_TOOL || a.status !== 'pending') {
      this.links.delete(token);
      throw new NotFoundException('This request is no longer open.');
    }
    const input = (a.toolInput ?? {}) as { target?: string; name?: string; reason?: string };
    return { label: secretLabel(input), reason: String(input.reason ?? ''), expiresInSec: Math.round((l.expiresAt - now) / 1000) };
  }

  async submit(token: string, value: string, now = Date.now()): Promise<void> {
    const l = this.find(token, now);
    if (++l.attempts > MAX_ATTEMPTS) {
      this.links.delete(token);
      throw new BadRequestException('Too many attempts — ask the assistant for a new link.');
    }
    await this.peek(token, now); // still pending?
    await this.approvals.submitSecret(l.approvalId, value, { displayName: 'secure link' });
    this.links.delete(token); // single use
  }
}
