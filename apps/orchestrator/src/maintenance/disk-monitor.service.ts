import { statfsSync } from 'node:fs';
import { dirname } from 'node:path';
import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { AppConfigService } from '../config/app-config.service';
import { DEFAULT_THRESHOLDS, diskLevel, formatBytes, limits, shouldNotify, thresholdsFromEnv, type DiskLevel, type DiskThresholds } from './disk-core';
import { MaintenanceService } from './maintenance.service';

export interface DiskStatus {
  path: string;
  totalBytes: number;
  freeBytes: number;
  usedPercent: number;
  level: DiskLevel;
  warnBelowBytes: number;
  criticalBelowBytes: number;
  checkedAt: string;
  /** What the last automatic relief freed (critical level), if it ran. */
  relief?: { at: string; bytes: number } | null;
}

const CHECK_MS = 10 * 60_000;
const RELIEF_EVERY_MS = 6 * 3_600_000;

/**
 * Watches the free space of the data disk every 10 minutes. A level change to warn / critical shows a banner in the dashboard and is sent to the
 * operators' chat (the default notification channel, else every allowed chat), at most every 12 h while it stays bad. At `critical` the safe,
 * regenerable caches are pruned automatically (digests, old fetched pages, old run folders) — never user files.
 */
@Injectable()
export class DiskMonitorService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('Disk');
  private readonly thresholds: DiskThresholds = thresholdsFromEnv(process.env);
  private timer?: NodeJS.Timeout;
  private current: DiskStatus | null = null;
  private lastNotifiedAt: number | null = null;
  private lastReliefAt = 0;
  private relief: { at: string; bytes: number } | null = null;

  constructor(
    private readonly config: AppConfigService,
    private readonly maintenance: MaintenanceService,
    private readonly moduleRef: ModuleRef,
  ) {}

  onApplicationBootstrap(): void {
    setTimeout(() => void this.check().catch(() => undefined), 30_000).unref();
    this.timer = setInterval(() => void this.check().catch(() => undefined), CHECK_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private read(): DiskStatus | null {
    const path = dirname(this.config.agentDir);
    try {
      const s = statfsSync(path);
      const total = s.blocks * s.bsize;
      const free = s.bavail * s.bsize;
      const l = limits(total, this.thresholds);
      return {
        path,
        totalBytes: total,
        freeBytes: free,
        usedPercent: total > 0 ? Math.round(((total - free) / total) * 100) : 0,
        level: diskLevel(free, total, this.thresholds),
        warnBelowBytes: l.warnAt,
        criticalBelowBytes: l.criticalAt,
        checkedAt: new Date().toISOString(),
        relief: this.relief,
      };
    } catch {
      return null; // an unreadable filesystem is not an alarm
    }
  }

  /** The latest reading (refreshed when it is more than a minute old). */
  status(): DiskStatus | null {
    if (!this.current || Date.now() - Date.parse(this.current.checkedAt) > 60_000) this.current = this.read() ?? this.current;
    return this.current;
  }

  async check(): Promise<DiskStatus | null> {
    const prev = this.current?.level ?? 'ok';
    let now = this.read();
    if (!now) return this.current;
    if (now.level === 'critical' && Date.now() - this.lastReliefAt > RELIEF_EVERY_MS) {
      this.lastReliefAt = Date.now();
      const freed = await this.maintenance.relieve().catch(() => null);
      if (freed) {
        this.relief = { at: new Date().toISOString(), bytes: freed.bytes };
        now = this.read() ?? now;
      }
    }
    this.current = now;
    if (shouldNotify(prev, now.level, this.lastNotifiedAt, Date.now())) {
      this.lastNotifiedAt = Date.now();
      await this.notify(now).catch((e) => this.logger.warn(`disk notice failed: ${(e as Error).message}`));
    }
    return now;
  }

  private async notify(s: DiskStatus): Promise<void> {
    const icon = s.level === 'critical' ? '🛑' : '⚠️';
    const freed = this.relief && Date.now() - Date.parse(this.relief.at) < 5 * 60_000 ? ` I already freed ${formatBytes(this.relief.bytes)} of caches.` : '';
    const text = `${icon} Disk space is ${s.level === 'critical' ? 'critically ' : ''}low on the server: ${formatBytes(s.freeBytes)} free of ${formatBytes(s.totalBytes)} (${100 - s.usedPercent}%).${freed} Open Settings → General → Disk & cleanup, or ask the admin for a cleanup report.`;
    this.logger.warn(text);
    const { ChannelManagerService } = await import('../channels/channel-manager.service');
    await this.moduleRef.get(ChannelManagerService, { strict: false }).notifyOperators(text);
  }
}

export { DEFAULT_THRESHOLDS };
