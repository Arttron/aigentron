import { randomBytes } from 'node:crypto';
import { stripControl } from './local-devices';

/** What the daemon says about itself when it asks to be connected (shown to the person who approves). */
export interface DeviceInfo {
  device: string;
  os: string;
  arch: string;
  version: string;
}

type Entry = { userCode: string; info: DeviceInfo; exp: number; state: 'pending' | 'approved' | 'denied'; uid?: string };

/** Characters that cannot be mixed up when read aloud or typed (no 0/O, 1/I/L). */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const field = (v: unknown, max: number): string => stripControl(v, max);

/**
 * The device authorization flow (like `gh auth login`): the daemon asks for a pair of codes, shows the short one with a link, the signed-in person approves it
 * on the dashboard, the daemon polls with the long (secret) one and gets its token once. In memory, short-lived.
 */
export class DeviceFlow {
  private readonly byDevice = new Map<string, Entry>();
  constructor(private readonly ttlMs = 10 * 60_000, private readonly intervalSec = 2) {}

  private sweep(now: number): void {
    for (const [k, v] of this.byDevice) if (v.exp <= now) this.byDevice.delete(k);
    while (this.byDevice.size > 100) this.byDevice.delete(this.byDevice.keys().next().value as string);
  }

  start(raw: Partial<Record<keyof DeviceInfo, unknown>>, now = Date.now()): { deviceCode: string; userCode: string; expiresInSec: number; intervalSec: number } {
    this.sweep(now);
    const info: DeviceInfo = { device: field(raw.device, 60) || 'Computer', os: field(raw.os, 20), arch: field(raw.arch, 20), version: field(raw.version, 40) };
    const bytes = randomBytes(8);
    const pick = (i: number) => ALPHABET[bytes[i]! % ALPHABET.length]!;
    let userCode = '';
    do userCode = `${[0, 1, 2, 3].map(pick).join('')}-${[4, 5, 6, 7].map(pick).join('')}`;
    while ([...this.byDevice.values()].some((e) => e.userCode === userCode)) bytes.set(randomBytes(8));
    const deviceCode = randomBytes(32).toString('base64url');
    this.byDevice.set(deviceCode, { userCode, info, exp: now + this.ttlMs, state: 'pending' });
    return { deviceCode, userCode, expiresInSec: Math.round(this.ttlMs / 1000), intervalSec: this.intervalSec };
  }

  private findUser(userCode: unknown, now: number): Entry | null {
    const c = typeof userCode === 'string' ? userCode.trim().toUpperCase() : '';
    for (const e of this.byDevice.values()) if (e.userCode === c && e.exp > now) return e;
    return null;
  }

  /** What a person sees before approving; null when the code is unknown / expired / already decided. */
  describe(userCode: unknown, now = Date.now()): { userCode: string; info: DeviceInfo } | null {
    const e = this.findUser(userCode, now);
    return e && e.state === 'pending' ? { userCode: e.userCode, info: e.info } : null;
  }

  decide(userCode: unknown, uid: string, approve: boolean, now = Date.now()): boolean {
    const e = this.findUser(userCode, now);
    if (!e || e.state !== 'pending') return false;
    e.state = approve ? 'approved' : 'denied';
    if (approve) e.uid = uid;
    return true;
  }

  /** The daemon's poll. An approval is handed over once (the entry is gone after). */
  poll(deviceCode: unknown, now = Date.now()): { status: 'pending' } | { status: 'denied' | 'expired' } | { status: 'approved'; uid: string; info: DeviceInfo } {
    const e = typeof deviceCode === 'string' && deviceCode.length <= 100 ? this.byDevice.get(deviceCode) : undefined;
    if (!e || e.exp <= now) {
      if (e) this.byDevice.delete(deviceCode as string);
      return { status: 'expired' };
    }
    if (e.state === 'pending') return { status: 'pending' };
    this.byDevice.delete(deviceCode as string);
    return e.state === 'approved' && e.uid ? { status: 'approved', uid: e.uid, info: e.info } : { status: 'denied' };
  }
}
