import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResearchMcpService } from './research-mcp.service';
import { ResearchService } from './research.service';

describe('ResearchMcpService token', () => {
  afterEach(() => {
    delete process.env.LDS_RESEARCH_MCP_REQUIRE_TOKEN;
    vi.useRealTimers();
  });
  it('needs a live run token by default; =0 restores the open behaviour', () => {
    const s = new ResearchMcpService({} as never);
    expect(s.authorized(undefined)).toBe(false);
    expect(s.authorized('Bearer nope')).toBe(false);
    const r = s.register();
    expect(s.authorized(`Bearer ${r.token}`)).toBe(true);
    r.dispose();
    expect(s.authorized(`Bearer ${r.token}`)).toBe(false);
    process.env.LDS_RESEARCH_MCP_REQUIRE_TOKEN = '0';
    expect(s.authorized(undefined)).toBe(true);
  });
  it('a token expires on its own', () => {
    vi.useFakeTimers();
    const s = new ResearchMcpService({} as never);
    const r = s.register(1000);
    expect(s.authorized(`Bearer ${r.token}`)).toBe(true);
    vi.advanceTimersByTime(1500);
    expect(s.authorized(`Bearer ${r.token}`)).toBe(false);
  });
});

describe('fetchPage SSRF', () => {
  const svc = new ResearchService({ agentDir: '/nonexistent' } as never);
  it.each(['https://127.0.0.1/', 'https://[::1]/', 'https://169.254.169.254/latest/meta-data', 'http://eur-lex.europa.eu/', 'https://user:p@eur-lex.europa.eu/', 'https://evil.com/?x=europa.eu'])('refuses %s', async (u) => {
    const out = await svc.fetchPage(u);
    expect(out).toMatch(/not an allowed|not allowed|Only https|credentials/);
  });
});
