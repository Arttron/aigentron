import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * One JSON file under `secretsDir` (auth.json, access.json, cloudflare-access.json,
 * voice.json …): mtime-cached reads, atomic 0600 writes. The same pattern was
 * copied into four services (C-26) and each copy `stat`ed the file on EVERY
 * call, i.e. 5–6 synchronous syscalls per HTTP request (C-22). Here the stat
 * itself is skipped for `ttlMs` after the last check; a write by this process
 * invalidates immediately, a change from outside (e.g. `make reset-password`
 * deleting auth.json) is seen within `ttlMs`.
 *
 * `parse` turns the raw JSON into the typed value (and may reject it → `missing`);
 * `missing` is what callers get when the file is absent or unreadable.
 */
export class SecretJsonFile<T> {
  private cache: { mtime: number; value: T; checkedAt: number } | null = null;

  constructor(
    private readonly path: string,
    private readonly opts: {
      parse: (raw: unknown) => T;
      missing: T;
      /** How long a cached value is trusted without a stat (default 2 s; 0 = stat every read). */
      ttlMs?: number;
      /** `JSON.stringify` spacing for writes (auth.json is compact, voice.json pretty). */
      pretty?: boolean;
      now?: () => number;
    },
  ) {}

  get file(): string {
    return this.path;
  }

  /** Current value — from cache, or re-read when the file changed (or the TTL passed). */
  read(): T {
    const now = this.now();
    const ttl = this.opts.ttlMs ?? 2000;
    if (this.cache && now - this.cache.checkedAt < ttl) return this.cache.value;
    let mtime: number;
    try {
      mtime = statSync(this.path).mtimeMs;
    } catch {
      this.cache = { mtime: 0, value: this.opts.missing, checkedAt: now };
      return this.opts.missing;
    }
    if (this.cache && this.cache.mtime === mtime) {
      this.cache.checkedAt = now;
      return this.cache.value;
    }
    let value: T;
    try {
      value = this.opts.parse(JSON.parse(readFileSync(this.path, 'utf8')));
    } catch {
      value = this.opts.missing;
    }
    this.cache = { mtime, value, checkedAt: now };
    return value;
  }

  /** Atomic write (tmp + chmod 0600 + rename), directory created 0700; the next read re-parses. */
  write(value: unknown): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, this.opts.pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
    this.invalidate();
  }

  /** Forget the cached value (the next read stats + re-parses). */
  invalidate(): void {
    this.cache = null;
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }
}
