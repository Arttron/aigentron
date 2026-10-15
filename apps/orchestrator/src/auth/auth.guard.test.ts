import { describe, expect, it } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from './auth.guard';

function make(opts: { configured?: boolean; uid?: string | null; mcpToken?: string }) {
  const auth = {
    isConfigured: () => opts.configured ?? true,
    sessionUserId: () => opts.uid ?? null,
    sessionIdOf: () => 'sid',
  };
  const sessions = { touch: () => undefined };
  const config = { mcpToken: opts.mcpToken ?? '' };
  return new AuthGuard(auth as never, config as never, sessions as never);
}
function call(guard: AuthGuard, path: string, remote = '203.0.113.9') {
  const req: { path: string; headers: Record<string, string>; socket: { remoteAddress: string }; authUserId?: string } = {
    path,
    headers: {},
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
});
