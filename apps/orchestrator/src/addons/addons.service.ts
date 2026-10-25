import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import {
  BUILTIN_DESCRIPTORS,
  VIEW_PREFIX,
  addonCommands,
  addonStatus,
  parseDescriptor,
  parseEndpoint,
  parseState,
  type AddonDescriptor,
  type AddonState,
  type AddonStatus,
  type Endpoint,
} from './addons-core';

export interface AddonHealth {
  ok: boolean;
  checkedAt: string;
  error: string | null;
}

/** What the dashboard gets for one add-on: the descriptor, the installer's state (if any) and a live health check. */
export interface AddonInfo extends AddonDescriptor {
  status: AddonStatus;
  state: AddonState | null;
  /** Why a present state file was ignored (shown to the operator; the add-on then counts as not installed). */
  stateError: string | null;
  health: AddonHealth | null;
  commands: ReturnType<typeof addonCommands>;
  /** The dashboard-side path of the view proxy (when this add-on has one), and the viewing limits. */
  view: { path: string; maxSessions: number; sessionMinutes: number; active: number } | null;
}

const PROBE_TTL_MS = 5_000;
const PROBE_TIMEOUT_MS = 1_500;

/**
 * Add-ons (docs/addons.md, "Orchestrator side"): optional server components the person installs with `aigentron addon
 * enable <name>` on the server. The orchestrator only READS: the shipped descriptors (`infra/addons/<name>/addon.json`,
 * with a built-in fallback for the browser), the installer's `state.json` under the data dir, and a short live probe of
 * the view endpoint (cached 5 s). Nothing here enables or disables anything — the dashboard shows the command to run.
 */
@Injectable()
export class AddonsService {
  private readonly logger = new Logger('Addons');
  private readonly probes = new Map<string, { at: number; result: AddonHealth }>();
  private readonly inflight = new Map<string, Promise<AddonHealth>>();
  /** Remembered warnings per file, so a broken file is reported once (the dashboard polls), not every 10 seconds. */
  private readonly warned = new Map<string, string>();
  /** How many people are watching the browser right now — set by the view proxy (it depends on this service, not the other way round). */
  activeViewers: () => number = () => 0;

  constructor(private readonly config: AppConfigService) {}

  private warnOnce(key: string, message: string): void {
    if (this.warned.get(key) === message) return;
    this.warned.set(key, message);
    this.logger.warn(message);
  }

  /** The shipped descriptors (a missing folder = the built-in list, so an older image still shows the browser add-on). */
  async descriptors(): Promise<AddonDescriptor[]> {
    const byName = new Map(BUILTIN_DESCRIPTORS.map((d) => [d.name, d]));
    const dir = this.config.addonsDescriptorsDir;
    let names: string[] = [];
    try {
      names = (await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      /* no infra/addons folder in this build: built-ins only */
    }
    for (const n of names) {
      const file = join(dir, n, 'addon.json');
      try {
        const r = parseDescriptor(JSON.parse(await readFile(file, 'utf8')));
        if (!r.ok) {
          this.warnOnce(file, `${file} ignored: ${r.error}`);
          continue;
        }
        if (r.value.name !== n) {
          this.warnOnce(file, `${file} ignored: its name "${r.value.name}" differs from the folder`);
          continue;
        }
        this.warned.delete(file);
        byName.set(r.value.name, r.value);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.warnOnce(file, `${file} ignored: ${(e as Error).message}`);
      }
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The installer's state file for one add-on; absent = not installed, unparsable = reported and treated as absent. */
  async readState(name: string): Promise<{ state: AddonState | null; error: string | null }> {
    const file = join(this.config.addonsDir, name, 'state.json');
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT' || (e as NodeJS.ErrnoException).code === 'ENOTDIR') return { state: null, error: null };
      return { state: null, error: `cannot read ${file}: ${(e as Error).message}` };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.warnOnce(file, `${file} ignored: not valid JSON`);
      return { state: null, error: 'state.json is not valid JSON' };
    }
    const r = parseState(parsed, name);
    if (!r.ok) {
      this.warnOnce(file, `${file} ignored: ${r.error}`);
      return { state: null, error: r.error };
    }
    this.warned.delete(file);
    return { state: r.value, error: null };
  }

  /** The validated view endpoint of an ENABLED add-on (what the proxy connects to), or null. */
  async viewEndpoint(name: string): Promise<Endpoint | null> {
    const { state } = await this.readState(name);
    if (!state?.enabled || !state.endpoints.view) return null;
    const ep = parseEndpoint(state.endpoints.view);
    return ep.ok ? ep.value : null;
  }

  /** Is the view endpoint answering? One short GET, cached for 5 s, shared between concurrent callers. */
  probe(view: string): Promise<AddonHealth> {
    const cached = this.probes.get(view);
    if (cached && Date.now() - cached.at < PROBE_TTL_MS) return Promise.resolve(cached.result);
    let p = this.inflight.get(view);
    if (!p) {
      p = this.doProbe(view).then((result) => {
        this.probes.set(view, { at: Date.now(), result });
        this.inflight.delete(view);
        return result;
      });
      this.inflight.set(view, p);
    }
    return p;
  }

  private async doProbe(view: string): Promise<AddonHealth> {
    const checkedAt = new Date().toISOString();
    try {
      const r = await fetch(`${view.replace(/\/+$/, '')}/`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), redirect: 'manual' });
      await r.body?.cancel().catch(() => undefined);
      return r.status < 500 ? { ok: true, checkedAt, error: null } : { ok: false, checkedAt, error: `HTTP ${r.status}` };
    } catch (e) {
      const err = e as Error & { cause?: NodeJS.ErrnoException };
      const detail = err.name === 'TimeoutError' ? `no answer within ${PROBE_TIMEOUT_MS} ms` : (err.cause?.code ?? err.cause?.message ?? err.message);
      return { ok: false, checkedAt, error: detail };
    }
  }

  async info(name: string): Promise<AddonInfo | null> {
    const d = (await this.descriptors()).find((x) => x.name === name);
    return d ? this.describe(d) : null;
  }

  async list(): Promise<AddonInfo[]> {
    return Promise.all((await this.descriptors()).map((d) => this.describe(d)));
  }

  private async describe(d: AddonDescriptor): Promise<AddonInfo> {
    const { state, error } = await this.readState(d.name);
    // the endpoint to look at: the browser add-on's view, else the MCP server of an add-on without a view
    const watched = state?.endpoints.view ?? state?.endpoints.mcp ?? null;
    const health = state?.enabled && watched ? await this.probe(watched) : null;
    const hasView = d.name === 'browser';
    return {
      ...d,
      status: addonStatus(state, health ? health.ok : state?.enabled ? false : null),
      state,
      stateError: error,
      health,
      commands: addonCommands(d.name),
      view: hasView
        ? { path: VIEW_PREFIX, maxSessions: this.config.addonViewMaxSessions, sessionMinutes: this.config.addonViewSessionMinutes, active: this.activeViewers() }
        : null,
    };
  }
}
