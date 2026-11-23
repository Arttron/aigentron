import { join } from 'node:path';
import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { SecretJsonFile } from '../security/secret-json-file';
import { type LocalDevice, newLocalDevice, stripControl, verifyLocalDevice } from './local-devices';

const TOUCH_EVERY_MS = 10 * 60_000;

/** The local agents paired with this server (`<secretsDir>/local-agent-devices.json`, hashes only). */
@Injectable()
export class LocalDevicesService {
  private store?: SecretJsonFile<LocalDevice[]>;
  private touched = new Map<string, number>();

  constructor(private readonly config: AppConfigService) {}

  private get file(): SecretJsonFile<LocalDevice[]> {
    return (this.store ??= new SecretJsonFile<LocalDevice[]>(join(this.config.secretsDir, 'local-agent-devices.json'), {
      missing: [],
      pretty: true,
      parse: (raw) => {
        const list = (raw as { devices?: unknown })?.devices;
        return Array.isArray(list) ? (list.filter((d) => d && typeof d.id === 'string' && typeof d.hash === 'string' && typeof d.userId === 'string') as LocalDevice[]) : [];
      },
    }));
  }

  private save(devices: LocalDevice[]): void {
    this.file.write({ devices } as never);
  }

  list(): LocalDevice[] {
    return this.file.read();
  }

  /** A new device for `userId`; the token is returned once and never stored. */
  add(userId: string, label: string, meta: { os?: unknown; arch?: unknown; host?: unknown; version?: unknown } = {}): { record: LocalDevice; token: string } {
    const d = newLocalDevice(userId, label, meta);
    this.save([...this.list().slice(-49), d.record]);
    return d;
  }

  remove(id: string): boolean {
    const all = this.list();
    if (!all.some((d) => d.id === id)) return false;
    this.save(all.filter((d) => d.id !== id));
    return true;
  }

  verify(token: string | undefined): LocalDevice | null {
    return verifyLocalDevice(this.list(), token);
  }

  /** What the daemon says about itself in its `hello`; written when it changed, and the last-seen time at most every ten minutes. */
  touch(id: string, meta: { os?: string; arch?: string; host?: string; version?: string } = {}, force = false): void {
    const now = Date.now();
    const d = this.list().find((x) => x.id === id);
    if (!d) return;
    const patch: Partial<LocalDevice> = {};
    for (const k of ['os', 'arch', 'host', 'version'] as const) {
      const v = stripControl(meta[k], 60);
      if (v && v !== d[k]) patch[k] = v;
    }
    if (!force && !Object.keys(patch).length && now - (this.touched.get(id) ?? 0) < TOUCH_EVERY_MS) return;
    this.touched.set(id, now);
    this.save(this.list().map((x) => (x.id === id ? { ...x, ...patch, lastSeenAt: new Date(now).toISOString() } : x)));
  }
}
