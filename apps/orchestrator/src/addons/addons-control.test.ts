import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppConfigService } from '../config/app-config.service';
import { controlPlan } from './addons-core';
import { AddonsService } from './addons.service';

describe('controlPlan', () => {
  const on = { enabled: true, backend: 'bare' as const };
  it('start / stop / restart of an installed, enabled, host-installed single-service add-on', () => {
    for (const a of ['start', 'stop', 'restart']) expect(controlPlan('playwright', a, on)).toEqual({ ok: true, action: a, units: ['aigentron-playwright.service'] });
    expect(controlPlan('voice', 'restart', on)).toMatchObject({ ok: true, units: ['aigentron-voice.service'] });
  });
  it('refuses anything else, with the reason', () => {
    expect(controlPlan('playwright', 'reload', on)).toMatchObject({ ok: false, error: expect.stringContaining('start, stop or restart') });
    expect(controlPlan('playwright', 'restart', null)).toMatchObject({ ok: false, error: expect.stringContaining('not installed') });
    expect(controlPlan('playwright', 'restart', { enabled: false, backend: 'bare' })).toMatchObject({ ok: false });
    expect(controlPlan('playwright', 'restart', { enabled: true, backend: 'docker' })).toMatchObject({ ok: false, error: expect.stringContaining('Docker') });
    expect(controlPlan('browser', 'restart', on)).toMatchObject({ ok: false, error: expect.stringContaining('not controlled') });
    // a name is never turned into a unit: nothing the caller sends reaches the command line
    expect(controlPlan('playwright; rm -rf /', 'restart', on)).toMatchObject({ ok: false });
  });
});

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

class Fake extends AddonsService {
  calls: string[][] = [];
  systemd = true;
  root = true;
  result = { ok: true, output: '' };
  protected override hasSystemd() {
    return this.systemd;
  }
  protected override isRoot() {
    return this.root;
  }
  protected override async systemctl(action: string, units: string[]) {
    this.calls.push([action, ...units]);
    return this.result;
  }
}

const make = () => {
  const d = mkdtempSync(join(tmpdir(), 'addons-'));
  dirs.push(d);
  mkdirSync(join(d, 'playwright'), { recursive: true });
  writeFileSync(
    join(d, 'playwright', 'state.json'),
    JSON.stringify({ name: 'playwright', enabled: true, backend: 'bare', version: '1', installedAt: null, browser: null, arch: null, endpoints: { view: null, cdp: null, mcp: 'http://127.0.0.1:9', api: null } }),
  );
  return new Fake({ addonsDir: d, addonsDescriptorsDir: join(d, 'none'), addonViewMaxSessions: 1, addonViewSessionMinutes: 1 } as unknown as AppConfigService);
};

describe('AddonsService.control', () => {
  it('runs systemctl with the fixed unit and says what happened', async () => {
    const s = make();
    const r = await s.control('playwright', 'stop', 'Artem');
    expect(s.calls).toEqual([['stop', 'aigentron-playwright.service']]);
    expect(r).toMatchObject({ ok: true, message: 'playwright stopped.' });
  });
  it('a failing systemctl is reported with its text', async () => {
    const s = make();
    s.result = { ok: false, output: 'Unit aigentron-playwright.service not found.' };
    const r = await s.control('playwright', 'restart');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('not found');
  });
  it('is refused (and nothing is run) without systemd or root rights, for a bad action, and for an add-on that is not controlled', async () => {
    const s = make();
    s.root = false;
    expect(await s.control('playwright', 'stop')).toMatchObject({ ok: false, message: expect.stringContaining('root') });
    s.root = true;
    s.systemd = false;
    expect(await s.control('playwright', 'stop')).toMatchObject({ ok: false, message: expect.stringContaining('systemd') });
    s.systemd = true;
    expect((await s.control('playwright', 'format')).ok).toBe(false);
    expect((await s.control('browser', 'stop')).ok).toBe(false);
    expect(s.calls).toEqual([]);
  });
  it('the add-on\'s info says whether the buttons can work here', async () => {
    const s = make();
    expect((await s.info('playwright'))!.control).toEqual({ available: true, reason: null });
    s.root = false;
    expect((await s.info('playwright'))!.control.available).toBe(false);
  });
});
