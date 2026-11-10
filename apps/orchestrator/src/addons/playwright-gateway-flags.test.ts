import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// The installer's `gateway_flags` (infra/addons/playwright/bare.sh) is run for real, with a fake data dir and .env.
const script = readFileSync(join(import.meta.dirname, '../../../../infra/addons/playwright/bare.sh'), 'utf8');
const fn = /^gateway_flags\(\) \{[\s\S]*?^\}/m.exec(script)![0];
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const flags = (env: Record<string, string>, dotenv?: string): string => {
  const root = mkdtempSync(join(tmpdir(), 'pw-gw-'));
  dirs.push(root);
  mkdirSync(join(root, 'data'));
  if (dotenv !== undefined) writeFileSync(join(root, '.env'), dotenv);
  return execFileSync('bash', ['-c', `DATA_DIR="${root}/data"; ${fn}\ngateway_flags`], { env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8' });
};

describe('the Playwright unit goes through the gateway', () => {
  it('by default: the gateway port 8940, local addresses direct', () => {
    expect(flags({})).toBe('--proxy-server http://127.0.0.1:8940 --proxy-bypass localhost,127.0.0.1');
  });
  it('the port is the orchestrator\'s own setting (the environment, or the .env beside the data dir)', () => {
    expect(flags({ PROXY_GATEWAY_PORT: '9100' })).toContain('http://127.0.0.1:9100');
    expect(flags({}, 'FOO=1\nPROXY_GATEWAY_PORT="9200"\n')).toContain('http://127.0.0.1:9200');
    expect(flags({}, 'PROXY_GATEWAY_PORT=abc\n')).toContain(':8940');
  });
  it('gateway switched off (port 0): no proxy flags, the browser goes direct', () => {
    expect(flags({ PROXY_GATEWAY_PORT: '0' })).toBe('');
    expect(flags({}, 'PROXY_GATEWAY_PORT=0\n')).toBe('');
  });
  it('the unit line carries the flags', () => {
    expect(script).toMatch(/--allowed-hosts localhost:\$PORT,127\.0\.0\.1:\$PORT \$\(gateway_flags\)/);
  });
});
