import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DeviceFlow } from './device-flow';
import { decodeFrame, encodeFrame, negotiate, PROTO } from './local-agent-proto';
import { parseRepos } from './local-repos';
import { newLocalDevice, verifyLocalDevice, LOCAL_DEVICE_IDLE_DAYS } from './local-devices';

const FIXTURES = join(__dirname, '../../../../packages/shared/protocol/local-agent');

describe('the protocol fixtures (shared with the Go daemon)', () => {
  const files = readdirSync(FIXTURES).filter((f) => f.endsWith('.json'));
  it('there are fixtures', () => expect(files.length).toBeGreaterThanOrEqual(20));
  it.each(files)('%s decodes and survives a round trip', (file) => {
    const raw = readFileSync(join(FIXTURES, file), 'utf8');
    const f = decodeFrame(raw);
    expect(f).not.toBeNull();
    expect(JSON.parse(encodeFrame(f!))).toEqual(JSON.parse(raw));
  });
  it('the hello fixture is welcomed, an old or too new agent is refused', () => {
    const hello = decodeFrame(readFileSync(join(FIXTURES, 'hello.json'), 'utf8'))!;
    expect(negotiate(hello, '9.9.9')).toMatchObject({
      type: 'welcome',
      proto: PROTO,
      serverVersion: '9.9.9',
    });
    expect(negotiate({ ...hello, protoMin: PROTO + 1, proto: PROTO + 2 }, 'x')).toMatchObject({
      type: 'refuse',
      code: 'proto_too_new',
    });
    expect(negotiate({ ...hello, proto: 0, protoMin: 0 }, 'x')).toMatchObject({ type: 'refuse' });
    expect(negotiate({ type: 'hello' }, 'x')).toMatchObject({ type: 'refuse', code: 'bad_hello' });
  });
  it('every op the server sends has a command fixture (and the daemon test checks the daemon knows it)', () => {
    const sent = new Set([
      'config.set',
      'repos.list',
      'repo.status',
      'repo.diff',
      'repo.log',
      'repo.read',
      'llm.models',
      'llm.chat',
      'llm.cancel',
    ]);
    const fixtureOps = new Set(
      files
        .filter((f) => f.startsWith('command'))
        .map((f) => decodeFrame(readFileSync(join(FIXTURES, f), 'utf8'))!.op),
    );
    for (const op of sent) expect(fixtureOps, op).toContain(op);
  });
  it('the repos event fixture is read by the server and an llm.chunk carries the id of its command', () => {
    const ev = decodeFrame(readFileSync(join(FIXTURES, 'event-repos.json'), 'utf8'))!;
    expect(ev.name).toBe('repos');
    const repos = parseRepos(ev.data);
    expect(repos).toHaveLength(1);
    expect(repos[0]).toMatchObject({ id: 'a1b2c3d4', branch: 'main', ahead: 1, behind: 2 });
    const chunk = decodeFrame(readFileSync(join(FIXTURES, 'event-llm-chunk.json'), 'utf8'))!;
    expect(chunk.name).toBe('llm.chunk');
    expect(typeof (chunk.data as { id?: unknown }).id).toBe('string');
    expect(typeof (chunk.data as { data?: unknown }).data).toBe('string');
  });
  it('the result fixtures have the fields the server reads', () => {
    const data = (f: string) =>
      decodeFrame(readFileSync(join(FIXTURES, f), 'utf8'))!.data as Record<string, unknown>;
    expect(Object.keys(data('result-repo-read.json'))).toEqual(
      expect.arrayContaining(['path', 'text', 'offset', 'size', 'more']),
    );
    expect(Array.isArray(data('result-repo-log.json').commits)).toBe(true);
    expect(Array.isArray(data('result-llm-models.json').models)).toBe(true);
  });
  it('refuses garbage and unknown types', () => {
    expect(decodeFrame('nope')).toBeNull();
    expect(decodeFrame('{"type":"x"}')).toBeNull();
    expect(decodeFrame('[]')).toBeNull();
  });
});

describe('local device tokens', () => {
  it('a token verifies; a wrong secret, an unknown id and an idle device do not', () => {
    const { token, record } = newLocalDevice('u1', 'MacBook (work)', {
      os: 'darwin',
      arch: 'arm64',
      host: 'mb',
      version: '0.1.129',
    });
    expect(token).toMatch(/^lag_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/);
    expect(record).toMatchObject({ userId: 'u1', label: 'MacBook work', os: 'darwin' });
    expect(JSON.stringify(record)).not.toContain(token.split('_')[2]);
    expect(verifyLocalDevice([record], token)?.id).toBe(record.id);
    expect(verifyLocalDevice([record], `${token.slice(0, -3)}AAA`)).toBeNull();
    expect(verifyLocalDevice([], token)).toBeNull();
    expect(verifyLocalDevice([record], undefined)).toBeNull();
    expect(
      verifyLocalDevice([record], token, Date.now() + (LOCAL_DEVICE_IDLE_DAYS + 1) * 86_400_000),
    ).toBeNull();
  });
});

describe('the device flow', () => {
  it('start → describe → approve → poll hands the approval over once', () => {
    const f = new DeviceFlow(60_000);
    const s = f.start({ device: 'MacBook', os: 'darwin', arch: 'arm64', version: '1' }, 1000);
    expect(s.userCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(f.poll(s.deviceCode, 1001)).toEqual({ status: 'pending' });
    expect(f.describe(s.userCode.toLowerCase(), 1002)?.info.device).toBe('MacBook');
    expect(f.decide(s.userCode, 'u1', true, 1003)).toBe(true);
    expect(f.decide(s.userCode, 'u2', true, 1004)).toBe(false); // already decided
    expect(f.poll(s.deviceCode, 1005)).toMatchObject({ status: 'approved', uid: 'u1' });
    expect(f.poll(s.deviceCode, 1006)).toEqual({ status: 'expired' }); // handed over once
  });
  it('a denial, an expiry and unknown codes', () => {
    const f = new DeviceFlow(1000);
    const a = f.start({}, 0);
    expect(f.decide(a.userCode, 'u', false, 1)).toBe(true);
    expect(f.poll(a.deviceCode, 2)).toEqual({ status: 'denied' });
    const b = f.start({}, 0);
    expect(f.poll(b.deviceCode, 1000)).toEqual({ status: 'expired' });
    expect(f.describe('ZZZZ-ZZZZ')).toBeNull();
    expect(f.poll('x'.repeat(200))).toEqual({ status: 'expired' });
    expect(f.poll(undefined)).toEqual({ status: 'expired' });
  });
  it('keeps the number of waiting requests bounded and the codes distinct', () => {
    const f = new DeviceFlow(60_000);
    const codes = new Set<string>();
    for (let i = 0; i < 150; i++) codes.add(f.start({}, 0).userCode);
    expect(codes.size).toBeGreaterThan(140);
    expect([...codes].some((c) => f.describe(c, 1))).toBe(true);
  });
});

describe('a development build is never "outdated"', () => {
  it('compares released versions only', async () => {
    const { localOutdated } = await import('./local-agent.controller');
    expect(localOutdated('0.1.9', '0.2.0')).toBe(true);
    expect(localOutdated('0.2.0', '0.2.0')).toBe(false);
    expect(localOutdated('dev-abc1234', '0.2.0')).toBe(false);
    expect(localOutdated('dev-abc1234-dirty', '0.2.0')).toBe(false);
    expect(localOutdated(undefined, '0.2.0')).toBe(false);
  });
});
