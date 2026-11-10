import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProxyStore, parseProxyFile } from './proxy-store';

const dirs: string[] = [];
const make = () => {
  const d = mkdtempSync(join(tmpdir(), 'proxies-'));
  dirs.push(d);
  return { path: join(d, 'secrets', 'proxies.json'), store: new ProxyStore(join(d, 'secrets', 'proxies.json')) };
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('ProxyStore', () => {
  it('saves a proxy from the seller\'s line; the view has no password; the file is private', () => {
    const { store, path } = make();
    const v = store.add('lt-1', 'res.proxy-seller.com;10000;user;SECRETpw');
    expect(v).toMatchObject({ name: 'lt-1', server: 'http://res.proxy-seller.com:10000', username: 'user', hasPassword: true, active: false });
    expect(JSON.stringify(store.list())).not.toContain('SECRETpw');
    expect(readFileSync(path, 'utf8')).toContain('SECRETpw'); // it is in the secrets file only
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
  it('refuses a bad name, a line that cannot be read, SOCKS, and a name that is taken (case aside)', () => {
    const { store } = make();
    expect(() => store.add('', 'h:80')).toThrow(/short name/);
    expect(() => store.add('x', 'nonsense')).toThrow(/cannot read/);
    expect(() => store.add('x', 'socks5://h:1080')).toThrow(/HTTP/);
    store.add('Lt', 'h.example:80');
    expect(() => store.add('lt', 'h.example:81')).toThrow(/already exists/);
  });
  it('the active connection: set, read with its password for the gateway, cleared when it is removed', () => {
    const { store } = make();
    const a = store.add('a', 'h.example;80;u;p');
    expect(store.active()).toBeNull();
    expect(store.setActive(a.id)).toBe(true);
    expect(store.active()).toMatchObject({ name: 'a', username: 'u', password: 'p' });
    expect(store.list()[0]!.active).toBe(true);
    expect(store.setActive('nope')).toBe(false);
    expect(store.remove(a.id)).toBe(true);
    expect(store.active()).toBeNull();
    expect(store.remove(a.id)).toBe(false);
    expect(store.setActive(null)).toBe(true);
  });
  it('remembers who chose, whether agents may switch, and finds a proxy by name (any case)', () => {
    const { store } = make();
    const a = store.add('Lt-1', 'h.example;80;u;p');
    expect(store.agentsCanSwitch()).toBe(true);
    store.setActive(a.id, 'agent (task t1)');
    expect(store.activeBy()).toMatchObject({ by: 'agent (task t1)' });
    expect(store.byName('lt-1')?.id).toBe(a.id);
    expect(store.byName('nope')).toBeNull();
    store.setAgentsCanSwitch(false);
    expect(store.agentsCanSwitch()).toBe(false);
  });
  it('a damaged file reads as empty; an active id that is gone is dropped', () => {
    expect(parseProxyFile('x')).toEqual({ items: [], active: null, activeBy: null, agentsCanSwitch: true });
    expect(parseProxyFile({ items: [{ id: 'a', name: 'n', server: 'http://h:1' }], active: 'zzz' }).active).toBeNull();
  });
});
