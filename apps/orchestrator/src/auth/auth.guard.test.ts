import { describe, expect, it } from 'vitest';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from './auth.guard';

function make(opts: { configured?: boolean; uid?: string | null; mcpToken?: string; device?: { id: string; userId: string } | null }) {
  const auth = {
    isConfigured: () => opts.configured ?? true,
    sessionUserId: () => opts.uid ?? null,
    sessionIdOf: () => 'sid',
  };
  const devices = { verify: (t: string | undefined) => (t === 'ext_good' ? (opts.device ?? null) : null) };
  const sessions = { touch: () => undefined };
  const config = { mcpToken: opts.mcpToken ?? '' };
  return new AuthGuard(auth as never, config as never, sessions as never, devices as never);
}
function call(guard: AuthGuard, path: string, remote = '203.0.113.9', method = 'GET', bearer?: string) {
  const req: { path: string; method: string; headers: Record<string, string>; socket: { remoteAddress: string }; authUserId?: string; extensionDeviceId?: string } = {
    path,
    method,
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
    socket: { remoteAddress: remote },
  };
  const ctx = { getType: () => 'http', switchToHttp: () => ({ getRequest: () => req }) };
  return { result: () => guard.canActivate(ctx as never), req };
}

describe('AuthGuard', () => {
  it('lets everything through before a password exists', () => {
    expect(call(make({ configured: false }), '/api/settings').result()).toBe(true);
  });
  it('public routes need no session', () => {
    for (const p of ['/api/health', '/api/auth/login', '/api/auth/status', '/api/secret-links/abc'])
      expect(call(make({}), p).result()).toBe(true);
  });
  it('a mutation without a session is 401', () => {
    for (const p of ['/api/settings', '/api/agents/x', '/api/providers', '/api/tasks/1/cancel', '/api/update/check'])
      expect(() => call(make({}), p).result()).toThrow(UnauthorizedException);
  });
  it('a valid session passes and sets authUserId', () => {
    const c = call(make({ uid: 'u1' }), '/api/settings');
    expect(c.result()).toBe(true);
    expect(c.req.authUserId).toBe('u1');
  });
  it('machine routes pass only from this machine', () => {
    expect(call(make({}), '/api/approvals/check', '127.0.0.1').result()).toBe(true);
    expect(() => call(make({}), '/api/approvals/check', '203.0.113.9').result()).toThrow(UnauthorizedException);
  });
  it('/api/mcp passes only when MCP_TOKEN is set', () => {
    expect(call(make({ mcpToken: 't' }), '/api/mcp').result()).toBe(true);
    expect(() => call(make({}), '/api/mcp').result()).toThrow(UnauthorizedException);
  });

  it('a browser extension has its own credential: it reaches only its own routes and acts as the user that paired it', () => {
    const g = make({ uid: null, device: { id: 'd1', userId: 'u7' } });
    const ok = call(g, '/api/extension/me', '203.0.113.9', 'GET', 'ext_good');
    expect(ok.result()).toBe(true);
    expect(ok.req.authUserId).toBe('u7');
    expect(ok.req.extensionDeviceId).toBe('d1');
    expect(call(g, '/api/projects', '203.0.113.9', 'GET', 'ext_good').result()).toBe(true);
    expect(() => call(g, '/api/settings', '203.0.113.9', 'GET', 'ext_good').result()).toThrow(ForbiddenException);
    expect(() => call(g, '/api/extension/pair', '203.0.113.9', 'POST', 'ext_good').result()).toThrow(ForbiddenException);
    // an unknown / revoked token is refused (not treated as «no token»)
    expect(() => call(g, '/api/extension/me', '203.0.113.9', 'GET', 'ext_nope').result()).toThrow(UnauthorizedException);
  });
  it('and it works the same on a server with no sign-in password (the domain is the binding)', () => {
    const g = make({ configured: false, device: { id: 'd1', userId: 'u7' } });
    const c = call(g, '/api/extension/me', '203.0.113.9', 'GET', 'ext_good');
    expect(c.result()).toBe(true);
    expect(c.req.authUserId).toBe('u7');
    expect(() => call(g, '/api/settings', '203.0.113.9', 'GET', 'ext_good').result()).toThrow(ForbiddenException); // still narrowed
    expect(() => call(g, '/api/extension/me', '203.0.113.9', 'GET', 'ext_nope').result()).toThrow(UnauthorizedException);
    // an ordinary request on an open server is untouched
    expect(call(g, '/api/settings').result()).toBe(true);
  });
});
