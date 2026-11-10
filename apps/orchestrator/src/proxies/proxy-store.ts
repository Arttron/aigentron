import { randomBytes } from 'node:crypto';
import { SecretJsonFile } from '../security/secret-json-file';
import { parseProxy } from './proxy-parse';

/** One saved proxy connection. The password lives only in the secrets file, never in an API answer. */
export interface ProxyItem {
  id: string;
  name: string;
  /** scheme://host:port */
  server: string;
  username?: string;
  password?: string;
  createdAt: string;
}

export interface ProxyFile {
  items: ProxyItem[];
  /** the connection the browser's traffic goes through; null = direct */
  active: string | null;
  /** who set it last and when: «you» (the dashboard) or «agent <task id>» — shown, so a switch by an agent is never a surprise */
  activeBy?: { by: string; at: string } | null;
  /** may agents choose among the saved proxies (the browser_proxy_use tool) */
  agentsCanSwitch: boolean;
}

/** What the dashboard sees: no password. */
export interface ProxyView {
  id: string;
  name: string;
  server: string;
  username: string | null;
  hasPassword: boolean;
  active: boolean;
  createdAt: string;
}

const NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,39}$/u;

export function parseProxyFile(raw: unknown): ProxyFile {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const items = (Array.isArray(o.items) ? o.items : []).flatMap((x): ProxyItem[] => {
    const i = x && typeof x === 'object' ? (x as Record<string, unknown>) : null;
    if (!i || typeof i.id !== 'string' || typeof i.name !== 'string' || typeof i.server !== 'string') return [];
    return [
      {
        id: i.id,
        name: i.name,
        server: i.server,
        ...(typeof i.username === 'string' && i.username ? { username: i.username } : {}),
        ...(typeof i.password === 'string' && i.password ? { password: i.password } : {}),
        createdAt: typeof i.createdAt === 'string' ? i.createdAt : new Date(0).toISOString(),
      },
    ];
  });
  const active = typeof o.active === 'string' && items.some((i) => i.id === o.active) ? o.active : null;
  const by = o.activeBy && typeof o.activeBy === 'object' ? (o.activeBy as Record<string, unknown>) : null;
  return { items, active, activeBy: by && typeof by.by === 'string' && typeof by.at === 'string' ? { by: by.by, at: by.at } : null, agentsCanSwitch: o.agentsCanSwitch !== false };
}

export const toView = (i: ProxyItem, active: string | null): ProxyView => ({
  id: i.id,
  name: i.name,
  server: i.server,
  username: i.username ?? null,
  hasPassword: Boolean(i.password),
  active: i.id === active,
  createdAt: i.createdAt,
});

/** The saved proxy connections (`secrets/proxies.json`, mode 0600). */
export class ProxyStore {
  private readonly file: SecretJsonFile<ProxyFile>;

  constructor(path: string) {
    this.file = new SecretJsonFile<ProxyFile>(path, { parse: parseProxyFile, missing: { items: [], active: null, activeBy: null, agentsCanSwitch: true }, ttlMs: 1000, pretty: true });
  }

  list(): ProxyView[] {
    const f = this.file.read();
    return f.items.map((i) => toView(i, f.active));
  }

  /** The connection the traffic goes through now (with its password: for the gateway only), or null for direct. */
  active(): ProxyItem | null {
    const f = this.file.read();
    return f.items.find((i) => i.id === f.active) ?? null;
  }

  get(id: string): ProxyItem | null {
    return this.file.read().items.find((i) => i.id === id) ?? null;
  }

  /** Saves a proxy written in any of the usual shapes. Throws a readable reason when it cannot be read or the name is taken. */
  add(name: string, line: string): ProxyView {
    const n = name.trim();
    if (!NAME.test(n)) throw new Error('give a short name (letters, digits, spaces and . _ - ; max 40 characters).');
    const p = parseProxy(line);
    if (p.server.startsWith('socks')) throw new Error('the gateway speaks HTTP / HTTPS proxies only (Chromium cannot log in to a SOCKS proxy anyway): use the seller\'s HTTP port.');
    const f = this.file.read();
    if (f.items.some((i) => i.name.toLowerCase() === n.toLowerCase())) throw new Error(`a proxy named "${n}" already exists.`);
    if (f.items.length >= 50) throw new Error('too many saved proxies (50).');
    const item: ProxyItem = { id: randomBytes(5).toString('hex'), name: n, server: p.server, ...(p.username ? { username: p.username } : {}), ...(p.password ? { password: p.password } : {}), createdAt: new Date().toISOString() };
    this.file.write({ ...f, items: [...f.items, item] });
    return toView(item, f.active);
  }

  remove(id: string): boolean {
    const f = this.file.read();
    if (!f.items.some((i) => i.id === id)) return false;
    this.file.write({ ...f, items: f.items.filter((i) => i.id !== id), active: f.active === id ? null : f.active, activeBy: f.active === id ? null : f.activeBy });
    return true;
  }

  /** null = direct. False when there is no such connection. `by`: who chose it («you», «agent <task id>»). */
  setActive(id: string | null, by = 'you'): boolean {
    const f = this.file.read();
    if (id !== null && !f.items.some((i) => i.id === id)) return false;
    this.file.write({ ...f, active: id, activeBy: { by, at: new Date().toISOString() } });
    return true;
  }

  agentsCanSwitch(): boolean {
    return this.file.read().agentsCanSwitch;
  }

  setAgentsCanSwitch(on: boolean): void {
    this.file.write({ ...this.file.read(), agentsCanSwitch: on });
  }

  activeBy(): { by: string; at: string } | null {
    return this.file.read().activeBy ?? null;
  }

  /** A saved proxy by its name (any case). */
  byName(name: string): ProxyItem | null {
    const n = name.trim().toLowerCase();
    return this.file.read().items.find((i) => i.name.toLowerCase() === n) ?? null;
  }
}
