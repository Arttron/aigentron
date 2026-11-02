import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { publicOrigin } from '../config/cors';
import { SecretJsonFile } from '../security/secret-json-file';
import { buildConfig, buildManifest, extensionIdFromKey, extensionVersion, generateExtensionKey, originOf, serverLabel, serverOrigins, type ExtensionKey } from './extension-package';
import { PairingCodes } from './extension-pairing';
import { createZip, type ZipEntry } from './zip';

/** Files of the shipped template that are never part of the package. */
const SKIP = new Set(['README.md', '.DS_Store']);

@Injectable()
export class ExtensionService {
  private readonly logger = new Logger(ExtensionService.name);
  readonly pairing = new PairingCodes(60_000);

  constructor(private readonly config: AppConfigService) {}

  private store?: SecretJsonFile<ExtensionKey | null>;
  private get keyFile(): SecretJsonFile<ExtensionKey | null> {
    return (this.store ??= new SecretJsonFile<ExtensionKey | null>(join(this.config.secretsDir, 'extension-key.json'), {
      missing: null,
      pretty: true,
      parse: (raw) => {
        const r = raw as Partial<ExtensionKey> | null;
        return r && typeof r.privateKeyPem === 'string' && typeof r.publicKeyDer === 'string' ? { privateKeyPem: r.privateKeyPem, publicKeyDer: r.publicKeyDer } : null;
      },
    }));
  }

  /** This server's key pair (made on first use and kept in the secrets dir): it fixes the extension's ID, so a re-download or an update keeps the stored login. */
  key(): ExtensionKey {
    let k = this.keyFile.read();
    if (!k) {
      k = generateExtensionKey();
      this.keyFile.write(k);
      this.logger.log('Generated this server\'s browser-extension key');
    }
    return k;
  }

  extensionId(): string {
    return extensionIdFromKey(this.key().publicKeyDer);
  }

  /** The version the shipped extension carries (what the update check compares with). */
  get extensionVersion(): string {
    return extensionVersion(this.version);
  }

  get version(): string {
    return process.env.APP_VERSION ?? 'dev';
  }

  templateDir(): string {
    return this.config.extensionDir;
  }

  async templateAvailable(): Promise<boolean> {
    return stat(join(this.templateDir(), 'manifest.json')).then(() => true, () => false);
  }

  /**
   * The addresses of this server for the package: the one the download came from first, then PUBLIC_URL, then the page address the dashboard
   * passes (`?origins=` — in a dev stack the page and the API are on different ports). An extra address is accepted only on the host of the
   * request or of PUBLIC_URL (a crafted link cannot give the package a broader reach) — except for a paired extension updating itself (`trusted`).
   */
  originsFor(requestOrigin: string | null, extra: string[], trusted = false): string[] {
    const pub = publicOrigin(process.env.PUBLIC_URL);
    const hosts = new Set([requestOrigin, pub].filter((o): o is string => !!o).map((o) => new URL(o).hostname));
    // `trusted`: the request carries a paired extension's own token — it asks for the package it already runs from, with the addresses it already has
    const accepted = extra.map((e) => originOf(e)).filter((o): o is string => !!o && (trusted || hosts.has(new URL(o).hostname)));
    return serverOrigins([requestOrigin, pub, ...accepted]);
  }

  private async readTemplate(dir: string): Promise<ZipEntry[]> {
    const out: ZipEntry[] = [];
    const walk = async (d: string): Promise<void> => {
      for (const e of await readdir(d, { withFileTypes: true })) {
        if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
        const full = join(d, e.name);
        if (e.isDirectory()) await walk(full);
        else if (e.isFile()) out.push({ name: relative(dir, full).split('\\').join('/'), data: await readFile(full) });
      }
    };
    await walk(dir);
    return out;
  }

  /** The zip of THIS server's extension: the shipped template with its manifest and config rewritten for these addresses. */
  async buildZip(origins: string[]): Promise<{ zip: Buffer; fileName: string; extensionId: string }> {
    if (!origins.length) throw new Error('no server address');
    const files = await this.readTemplate(this.templateDir());
    const manifestFile = files.find((f) => f.name === 'manifest.json');
    if (!manifestFile) throw new Error('the extension template has no manifest.json');
    const template = JSON.parse(manifestFile.data.toString('utf8')) as Record<string, unknown>;
    const key = this.key();
    const label = serverLabel(origins);
    const manifest = buildManifest({ template, serverName: label, origins, serverVersion: this.version, publicKeyDer: key.publicKeyDer });
    const extensionId = extensionIdFromKey(key.publicKeyDer);
    const entries = files
      .filter((f) => f.name !== 'manifest.json' && f.name !== 'config.json')
      .concat([
        { name: 'manifest.json', data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) },
        { name: 'config.json', data: Buffer.from(`${JSON.stringify(buildConfig({ serverName: label, origins, serverVersion: this.version, extensionId }), null, 2)}\n`) },
      ]);
    const safe = label.replace(/[^a-z0-9.-]+/gi, '-').replace(/^-+|-+$/g, '') || 'server';
    return { zip: createZip(entries), fileName: `aigentron-extension-${safe}.zip`, extensionId };
  }
}
