import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalAgentPackageService, type Fetcher } from './local-agent-package.service';
import type { AppConfigService } from '../config/app-config.service';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const reply = (body: Buffer | string | null, status = 200) => ({ ok: status === 200, status, arrayBuffer: async () => (body === null ? new ArrayBuffer(0) : Uint8Array.from(Buffer.from(body)).buffer) });

function make(files: Record<string, Buffer | string>) {
  const dir = mkdtempSync(join(tmpdir(), 'lag-'));
  const svc = new LocalAgentPackageService({ agentDir: dir } as AppConfigService);
  const calls: string[] = [];
  svc.fetcher = (async (url: string) => {
    calls.push(url);
    const hit = files[url.split('/').pop()!];
    return hit === undefined ? reply(null, 404) : reply(hit);
  }) as Fetcher;
  return { svc, dir, calls };
}

afterEach(() => vi.unstubAllEnvs());

describe('LocalAgentPackageService', () => {
  const data = Buffer.from('binary');
  const name = 'aigentron-local_0.1.130_linux_amd64.tar.gz';

  it('fetches, verifies, caches — the second call does not touch the network', async () => {
    vi.stubEnv('APP_VERSION', '0.1.130');
    const { svc, calls, dir } = make({ SHA256SUMS: `${sha(data)}  ${name}\n`, [name]: data });
    const r = await svc.get('linux', 'amd64');
    expect(r.sha256).toBe(sha(data));
    expect(readFileSync(r.file)).toEqual(data);
    expect(r.file.startsWith(dir)).toBe(true);
    const n = calls.length;
    expect((await svc.get('linux', 'amd64')).sha256).toBe(sha(data));
    expect(calls.length).toBe(n);
    expect(calls[0]).toContain('/releases/download/v0.1.130/');
  });

  it('refuses a file that does not match the release checksum', async () => {
    vi.stubEnv('APP_VERSION', '0.1.130');
    const { svc } = make({ SHA256SUMS: `${'0'.repeat(64)}  ${name}\n`, [name]: data });
    await expect(svc.get('linux', 'amd64')).rejects.toThrow(/does not match/);
  });

  it('says so when the release has no such file, on a dev build and for an unknown platform', async () => {
    vi.stubEnv('APP_VERSION', '0.1.130');
    await expect(make({}).svc.get('linux', 'amd64')).rejects.toThrow(/SHA256SUMS/);
    await expect(make({ SHA256SUMS: 'nothing' }).svc.get('linux', 'amd64')).rejects.toThrow(/no entry/);
    await expect(make({}).svc.get('plan9', 'amd64')).rejects.toThrow(/No local agent/);
    vi.stubEnv('APP_VERSION', 'dev');
    await expect(make({}).svc.get('linux', 'amd64')).rejects.toThrow(/development build/);
  });
});
