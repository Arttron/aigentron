import { join } from 'node:path';
import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { SecretJsonFile } from '../security/secret-json-file';
import { type DeviceRecord, newDevice, verifyDevice } from './extension-devices';

const TOUCH_EVERY_MS = 10 * 60_000;

/** The browser extensions paired with this server (`<secretsDir>/extension-devices.json`, hashes only). Lives with the auth guard, which checks their tokens. */
@Injectable()
export class ExtensionDevicesService {
  private store?: SecretJsonFile<DeviceRecord[]>;
  private touched = new Map<string, number>();

  constructor(private readonly config: AppConfigService) {}

  private get file(): SecretJsonFile<DeviceRecord[]> {
    return (this.store ??= new SecretJsonFile<DeviceRecord[]>(join(this.config.secretsDir, 'extension-devices.json'), {
      missing: [],
      pretty: true,
      parse: (raw) => {
        const list = (raw as { devices?: unknown })?.devices;
        return Array.isArray(list) ? (list.filter((d) => d && typeof d.id === 'string' && typeof d.hash === 'string' && typeof d.userId === 'string') as DeviceRecord[]) : [];
      },
    }));
  }

  private save(devices: DeviceRecord[]): void {
    this.file.write({ devices } as never);
  }

  list(): DeviceRecord[] {
    return this.file.read();
  }

  /** A new device for `userId`; the token is returned once and never stored. */
  add(userId: string, label: string): { record: DeviceRecord; token: string } {
    const d = newDevice(userId, label);
    this.save([...this.list().slice(-49), d.record]);
    return d;
  }

  remove(id: string): boolean {
    const all = this.list();
    if (!all.some((d) => d.id === id)) return false;
    this.save(all.filter((d) => d.id !== id));
    return true;
  }

  /** The device behind a request's token (and a note of the activity, written at most every ten minutes). */
  verify(token: string | undefined, reportedVersion?: unknown): DeviceRecord | null {
    const d = verifyDevice(this.list(), token);
    if (!d) return null;
    const now = Date.now();
    // the version the extension says it is (a changed one is written at once: the dashboard shows who needs an update)
    const version = typeof reportedVersion === 'string' && /^\d{1,6}(\.\d{1,6}){0,3}$/.test(reportedVersion) ? reportedVersion : undefined;
    if (version && version !== d.version) {
      this.touched.set(d.id, now);
      this.save(this.list().map((x) => (x.id === d.id ? { ...x, version, lastSeenAt: new Date(now).toISOString() } : x)));
      return { ...d, version };
    }
    if (now - (this.touched.get(d.id) ?? 0) >= TOUCH_EVERY_MS) {
      this.touched.set(d.id, now);
      this.save(this.list().map((x) => (x.id === d.id ? { ...x, lastSeenAt: new Date(now).toISOString() } : x)));
    }
    return d;
  }
}
