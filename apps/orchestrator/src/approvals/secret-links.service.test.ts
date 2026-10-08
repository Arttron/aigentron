import { afterEach, describe, expect, it, vi } from 'vitest';
import { REQUEST_SECRET_TOOL } from '@lds/shared';
import { SecretLinksService, secretLabel } from './secret-links.service';

function env(status = 'pending', toolName: string = REQUEST_SECRET_TOOL) {
  const approvals = {
    get: vi.fn(async () => ({ toolName, status, toolInput: { target: 'channel', name: 'my-bot', reason: 'telegram token' } })),
    submitSecret: vi.fn(async () => undefined),
  };
  return { approvals, svc: new SecretLinksService(approvals as never) };
}
const token = (url: string) => url.split('/secret/')[1]!;

afterEach(() => {
  delete process.env.PUBLIC_URL;
});

describe('secretLabel', () => {
  it('says what is being asked for', () => {
    expect(secretLabel({ target: 'provider', name: 'GPT' })).toContain('provider "GPT"');
    expect(secretLabel({ target: 'github_token' })).toBe('GitHub token');
    expect(secretLabel({ target: 'channel', name: 'my-bot' })).toContain('channel "my-bot"');
  });
});

describe('SecretLinksService', () => {
  it('offers no link without a public address', () => {
    expect(env().svc.create('a1')).toBeNull();
  });

  it('creates a link on the public address; the page can read WHAT is asked, not any secret', async () => {
    process.env.PUBLIC_URL = 'https://dev.example.com/some/path';
    const { svc } = env();
    const url = svc.create('a1', 0)!;
    expect(url.startsWith('https://dev.example.com/secret/')).toBe(true);
    expect(token(url).length).toBeGreaterThan(40);
    const info = await svc.peek(token(url), 1000);
    expect(info.label).toContain('channel "my-bot"');
    expect(info.expiresInSec).toBeGreaterThan(500);
  });

  it('works once', async () => {
    process.env.PUBLIC_URL = 'https://dev.example.com';
    const { svc, approvals } = env();
    const t = token(svc.create('a1', 0)!);
    await svc.submit(t, '123:abc', 1000);
    expect(approvals.submitSecret).toHaveBeenCalledWith('a1', '123:abc', { displayName: 'secure link' });
    await expect(svc.submit(t, 'again', 2000)).rejects.toThrow(/expired|already used/);
  });

  it('expires after 10 minutes', async () => {
    process.env.PUBLIC_URL = 'https://dev.example.com';
    const { svc, approvals } = env();
    const t = token(svc.create('a1', 0)!);
    await expect(svc.submit(t, 'x', 11 * 60_000)).rejects.toThrow(/expired/);
    expect(approvals.submitSecret).not.toHaveBeenCalled();
  });

  it('is dead once the request is no longer pending, or is not a secret request', async () => {
    process.env.PUBLIC_URL = 'https://dev.example.com';
    const a = env('approved');
    await expect(a.svc.peek(token(a.svc.create('a1', 0)!), 1)).rejects.toThrow(/no longer open/);
    const b = env('pending', 'Bash');
    await expect(b.svc.peek(token(b.svc.create('a1', 0)!), 1)).rejects.toThrow(/no longer open/);
  });

  it('rejects a made-up token and gives up after repeated failed submits', async () => {
    process.env.PUBLIC_URL = 'https://dev.example.com';
    const { svc, approvals } = env();
    await expect(svc.peek('not-a-token')).rejects.toThrow(/expired|already used/);
    approvals.submitSecret.mockRejectedValue(new Error('empty'));
    const t = token(svc.create('a1', 0)!);
    for (let i = 0; i < 5; i++) await expect(svc.submit(t, '', 1000)).rejects.toThrow('empty');
    await expect(svc.submit(t, 'x', 1000)).rejects.toThrow(/Too many attempts/);
  });

  it('every link is different', () => {
    process.env.PUBLIC_URL = 'https://dev.example.com';
    const { svc } = env();
    expect(svc.create('a1')).not.toBe(svc.create('a1'));
  });
});
