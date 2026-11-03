import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error plain JS module
import { NO_ACCESS_MESSAGE, handleCommand } from './agent.js';

/** A browser with the permissions the test sets: `granted` is what chrome.permissions.contains answers. */
function fakeChrome(granted: boolean, tab?: { id: number; url?: string }) {
  const session: Record<string, unknown> = { agentState: { windowId: 1, groupId: null, tabs: tab ? [tab.id] : [], shared: [] } };
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: { session: { get: async (k: string) => ({ [k]: session[k] }), set: async (o: Record<string, unknown>) => void Object.assign(session, o), remove: async () => undefined }, local: { get: async () => ({}) , set: async () => undefined } },
    permissions: { contains: async () => granted },
    tabs: { get: async () => tab ?? null },
    runtime: { getManifest: () => ({ version: '1.0.0' }), getURL: (p: string) => `chrome-extension://x/${p}`, id: 'x' },
  };
}
beforeEach(() => {
  (globalThis as { fetch: unknown }).fetch = async () => ({ ok: true, json: async () => ({ origins: [], serverName: 't' }) });
});
afterEach(() => delete (globalThis as { chrome?: unknown }).chrome);

describe('an agent command without the browser giving the extension access to sites', () => {
  beforeEach(() => undefined);
  it('open: tells the agent plainly, before anything is asked of the person', async () => {
    fakeChrome(false);
    const r = await handleCommand({ tool: 'open', args: { url: 'https://example.com', allowHosts: ['example.com'], ownOrigins: [] } });
    expect(r.ok).toBe(false);
    expect(r.error).toBe(NO_ACCESS_MESSAGE);
    expect(r.error).toContain('Allow agents to use my browser');
  });
  it('a tab whose address Chrome hides is not «not showing a web page»: the same message', async () => {
    fakeChrome(false, { id: 7, url: undefined });
    const r = await handleCommand({ tool: 'snapshot', args: { tabId: 7, allowHosts: [], ownOrigins: [] } });
    expect(r.ok).toBe(false);
    expect(r.error).toBe(NO_ACCESS_MESSAGE);
  });
  it('with the access, a tab that really shows no web page keeps the old message', async () => {
    fakeChrome(true, { id: 7, url: 'chrome://settings' });
    const r = await handleCommand({ tool: 'snapshot', args: { tabId: 7, allowHosts: [], ownOrigins: [] } });
    expect(r.error).toBe('This tab is not showing a web page.');
  });
});
