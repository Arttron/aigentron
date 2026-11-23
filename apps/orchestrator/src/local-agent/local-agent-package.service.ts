import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { assetName, isPlatform, parseSums } from './install-script';

const MAX_BYTES = 60 * 1024 * 1024;

export type Fetcher = (url: string) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;

/**
 * The local agent's binaries for THIS server's version. The server never builds them (as with the extension): it fetches the release asset of its own version from the
 * public release (or the repository set with UPDATE_REPO), checks it against the release's SHA256SUMS and keeps it in `<agent dir>/cache/local-agent/<version>/`.
 */
@Injectable()
export class LocalAgentPackageService {
  private readonly logger = new Logger(LocalAgentPackageService.name);
  private readonly inflight = new Map<string, Promise<{ file: string; sha256: string; name: string }>>();
  fetcher: Fetcher = (url) => fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120_000) });

  constructor(private readonly config: AppConfigService) {}

  get version(): string {
    return process.env.APP_VERSION ?? 'dev';
  }

  private get repo(): string {
    return process.env.UPDATE_REPO?.trim() || 'Arttron/aigentron';
  }

  async get(os: string, arch: string): Promise<{ file: string; sha256: string; name: string }> {
    if (!isPlatform(os, arch)) throw new NotFoundException('No local agent is built for this platform.');
    if (!/^\d+\.\d+\.\d+$/.test(this.version)) throw new NotFoundException('This server is a development build: it has no release of the local agent to hand out.');
    const key = `${os}/${arch}`;
    let p = this.inflight.get(key);
    if (!p) {
      p = this.load(os, arch).finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return p;
  }

  private async load(os: string, arch: string): Promise<{ file: string; sha256: string; name: string }> {
    const version = this.version;
    const name = assetName(version, os, arch);
    const dir = join(this.config.agentDir, 'cache', 'local-agent', version);
    const file = join(dir, name);
    const shaFile = `${file}.sha256`;
    const cached = await Promise.all([readFile(shaFile, 'utf8'), stat(file)]).then(([sha]) => sha.trim(), () => null);
    if (cached && /^[0-9a-f]{64}$/.test(cached)) return { file, sha256: cached, name };

    const base = `https://github.com/${this.repo}/releases/download/v${version}`;
    const get = async (url: string): Promise<Buffer> => {
      let res;
      try {
        res = await this.fetcher(url);
      } catch (e) {
        throw new ServiceUnavailableException(`Could not reach the release (${(e as Error).message}).`);
      }
      if (!res.ok) throw new NotFoundException(`The release has no ${url.split('/').pop()} (HTTP ${res.status}).`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_BYTES) throw new ServiceUnavailableException('The release file is unexpectedly large.');
      return buf;
    };
    const sums = parseSums((await get(`${base}/SHA256SUMS`)).toString('utf8'));
    const want = sums.get(name);
    if (!want) throw new NotFoundException(`The release's SHA256SUMS has no entry for ${name}.`);
    const data = await get(`${base}/${name}`);
    const got = createHash('sha256').update(data).digest('hex');
    if (got !== want) {
      this.logger.error(`Checksum mismatch for ${name}: expected ${want}, got ${got}`);
      throw new ServiceUnavailableException('The downloaded file does not match the release checksum — refusing to hand it out.');
    }
    await mkdir(dir, { recursive: true });
    await writeFile(`${file}.tmp`, data, { mode: 0o644 });
    await rename(`${file}.tmp`, file);
    await writeFile(shaFile, `${got}\n`);
    this.logger.log(`Cached ${name} (${data.length} bytes)`);
    return { file, sha256: got, name };
  }
}
