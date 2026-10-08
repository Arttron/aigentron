import { randomBytes } from 'node:crypto';
import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';

/** What it takes to revert one admin change (secrets are never part of it). */
export type UndoInfo =
  | { kind: 'settings'; before: Record<string, unknown> }
  | { kind: 'provider'; name: string; before: { kind: string; model: string; baseUrl: string | null; authMode: string } | null }
  | { kind: 'agent' | 'skill'; name: string; snapshot: string | null }
  | { kind: 'agent_delete'; name: string; snapshot: string | null };

export interface AuditEntry {
  id: string;
  ts: string;
  taskId: string;
  tool: string;
  summary: string;
  undo?: UndoInfo;
  undone?: boolean;
}

/**
 * Append-only journal of what the admin agent actually changed (`<agentDir>/admin-audit.jsonl`), written only AFTER an
 * approved change was applied. It powers `admin_history` and `propose_undo`. Small by nature (one line per approved change).
 */
@Injectable()
export class AdminAuditService {
  private readonly logger = new Logger(AdminAuditService.name);

  constructor(private readonly config: AppConfigService) {}

  private get file(): string {
    return join(this.config.agentDir, 'admin-audit.jsonl');
  }

  private async readAll(): Promise<AuditEntry[]> {
    const raw = await readFile(this.file, 'utf8').catch(() => '');
    const out: AuditEntry[] = [];
    const undone = new Set<string>();
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line) as AuditEntry & { undoneId?: string };
        if (o.undoneId) undone.add(o.undoneId); // marker line (append-only: no rewrite, no lost concurrent appends)
        else out.push(o);
      } catch {
        /* skip a damaged line */
      }
    }
    for (const e of out) if (undone.has(e.id)) e.undone = true;
    return out;
  }

  async record(e: Omit<AuditEntry, 'id' | 'ts'>): Promise<AuditEntry> {
    const entry: AuditEntry = { id: randomBytes(4).toString('hex'), ts: new Date().toISOString(), ...e };
    await this.append(entry);
    return entry;
  }

  /** Newest first. */
  async list(limit = 20): Promise<AuditEntry[]> {
    return (await this.readAll()).reverse().slice(0, Math.max(1, Math.min(200, limit)));
  }

  async get(id: string): Promise<AuditEntry | null> {
    return (await this.readAll()).find((e) => e.id === id) ?? null;
  }

  async markUndone(id: string): Promise<void> {
    if (!(await this.get(id))) return;
    await this.append({ undoneId: id, ts: new Date().toISOString() });
  }

  private writes: Promise<unknown> = Promise.resolve();
  /** Appends are serialized so concurrent admin chats / batches can't interleave or drop lines. */
  private append(obj: unknown): Promise<void> {
    const next = this.writes.then(() =>
      appendFile(this.file, `${JSON.stringify(obj)}\n`).catch((err) => this.logger.warn(`audit write failed: ${(err as Error).message}`)),
    );
    this.writes = next;
    return next as Promise<void>;
  }
}
