import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error plain JS modules
import { isScriptBlocked, isScriptRefusal, readableFromHtml } from './htmltext.js';
// @ts-expect-error plain JS module
import { handleCommand } from './agent.js';

const PAGE = `<!doctype html><html><head><title>JSON Formatter &amp; Viewer – Chrome Web Store</title>
<meta name="description" content="Makes JSON easy to read. 1,000,000 users">
<meta property="og:title" content="JSON Formatter">
<script type="application/ld+json">{"@type":"SoftwareApplication","name":"JSON Formatter","aggregateRating":{"ratingValue":4.7,"ratingCount":2105}}</script>
<script>var data = {"users":"1,000,000","x":1}; /* userCount */</script>
<style>.a{color:red}</style></head>
<body><h1>JSON Formatter</h1><p>Makes JSON&nbsp;easy to read.</p><ul><li>Fast</li><li>Free</li></ul><noscript>Enable JS</noscript></body></html>`;

describe('which pages Chrome refuses to script', () => {
  it('the Web Store and the browser\'s own pages', () => {
    for (const u of ['https://chromewebstore.google.com/detail/x/abc', 'https://chrome.google.com/webstore/detail/x', 'chrome://settings', 'chrome-extension://abc/popup.html', 'about:blank']) expect(isScriptBlocked(u), u).toBe(true);
    for (const u of ['https://addons.mozilla.org/', 'https://example.com/webstore', 'http://localhost:3000/', 'not a url']) expect(isScriptBlocked(u), u).toBe(false);
  });
  it('recognises the browser\'s refusal by its words', () => {
    expect(isScriptRefusal(new Error('The extensions gallery cannot be scripted.'))).toBe(true);
    expect(isScriptRefusal(new Error('Cannot access contents of the page. Extension manifest must request permission'))).toBe(true);
    expect(isScriptRefusal(new Error('No tab with id: 5'))).toBe(false);
  });
});

describe('readableFromHtml', () => {
  it('takes the title, descriptions, structured data, embedded numbers and the visible text out of the source', () => {
    const r = readableFromHtml(PAGE, 'https://chromewebstore.google.com/detail/x');
    expect(r.title).toBe('JSON Formatter & Viewer – Chrome Web Store');
    expect(r.source).toBe('fetched');
    expect(r.text).toContain('description: Makes JSON easy to read. 1,000,000 users');
    expect(r.text).toContain('"ratingValue":4.7');
    expect(r.text).toContain('"users":"1,000,000"');
    expect(r.text).toContain('Makes JSON easy to read.');
    expect(r.text).toContain('Fast');
    expect(r.text).not.toContain('color:red'); // styles and scripts are not page text
    expect(r.text).not.toContain('Enable JS');
  });
  it('pages the text like readPage does', () => {
    const big = `<html><body>${'<p>word </p>'.repeat(5000)}</body></html>`;
    const a = readableFromHtml(big, 'u', 0, 1000);
    expect(a.more).toBe(true);
    expect(readableFromHtml(big, 'u', a.offset, 1000).text.length).toBeGreaterThan(0);
  });
  it('an empty shell gives an empty text, not an error', () => {
    expect(readableFromHtml('<html><body></body></html>', 'u').text).toBe('');
  });
});

describe('the agent reads a page Chrome will not script', () => {
  beforeEach(() => {
    (globalThis as { fetch: unknown }).fetch = async (u: string) => (String(u).startsWith('chrome-extension://') ? { ok: true, json: async () => ({ origins: [] }) } : { ok: true, status: 200, text: async () => PAGE });
    const session: Record<string, unknown> = { agentState: { windowId: 1, groupId: null, tabs: [9], shared: [] } };
    (globalThis as unknown as { chrome: unknown }).chrome = {
      storage: { session: { get: async (k: string) => ({ [k]: session[k] }), set: async () => undefined, remove: async () => undefined } },
      permissions: { contains: async () => true },
      tabs: { get: async () => ({ id: 9, url: 'https://chromewebstore.google.com/detail/json-formatter/abc', status: 'complete' }) },
      scripting: { executeScript: async () => { throw new Error('The extensions gallery cannot be scripted.'); } },
      runtime: { getURL: (p: string) => `chrome-extension://x/${p}`, id: 'x', getManifest: () => ({ version: '1' }) },
    };
  });
  afterEach(() => delete (globalThis as { chrome?: unknown }).chrome);
  const args = { tabId: 9, allowHosts: ['chromewebstore.google.com'], allow: { read: ['chromewebstore.google.com'], interact: [] }, ownOrigins: [] };

  it('read and snapshot fall back to the page source, with a note that says what is missing', async () => {
    for (const tool of ['read', 'snapshot']) {
      const r = await handleCommand({ tool, args });
      expect(r.ok, tool).toBe(true);
      expect(r.data.source).toBe('fetched');
      expect(r.data.text).toContain('"ratingValue":4.7');
      expect(r.data.note).toMatch(/does not let an extension run scripts/);
    }
  });
  it('click / type on such a page say it can only be read', async () => {
    const r = await handleCommand({ tool: 'click', args: { ...args, ref: 'e1', allow: { read: ['chromewebstore.google.com'], interact: ['chromewebstore.google.com'] } } });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/only READ it/);
  });
});

describe('the third stage: a picture when the source has nothing', () => {
  const EMPTY = '<html><head><title>Chrome Web Store</title></head><body><div id="app"></div><script>window.x=1</script></body></html>';
  it('thin: an empty shell; not thin: a page with structured data or text', () => {
    expect(readableFromHtml(EMPTY, 'u').thin).toBe(true);
    expect(readableFromHtml(PAGE, 'u').thin).toBe(false);
  });

  function browser(html: string, shot: 'ok' | 'refused') {
    (globalThis as { fetch: unknown }).fetch = async (u: string) =>
      String(u).startsWith('data:') ? { blob: async () => new Blob([new Uint8Array([1, 2, 3])]) } : { ok: true, status: 200, text: async () => html };
    (globalThis as { createImageBitmap: unknown }).createImageBitmap = async () => ({ width: 100, height: 50 });
    (globalThis as { OffscreenCanvas: unknown }).OffscreenCanvas = class {
      getContext() {
        return { drawImage() {} };
      }
      async convertToBlob() {
        return new Blob([new Uint8Array([9, 9, 9])]);
      }
    };
    const session: Record<string, unknown> = { agentState: { windowId: 1, groupId: null, tabs: [9], shared: [] } };
    (globalThis as unknown as { chrome: unknown }).chrome = {
      storage: { session: { get: async (k: string) => ({ [k]: session[k] }), set: async () => undefined, remove: async () => undefined } },
      permissions: { contains: async () => true },
      tabs: {
        get: async () => ({ id: 9, windowId: 1, url: 'https://chromewebstore.google.com/detail/x/abc', status: 'complete' }),
        update: async () => undefined,
        captureVisibleTab: async () => {
          if (shot === 'refused') throw new Error('Cannot access contents of the page.');
          return 'data:image/png;base64,AAAA';
        },
      },
      scripting: { executeScript: async () => { throw new Error('The extensions gallery cannot be scripted.'); } },
      runtime: { getURL: (p: string) => `chrome-extension://x/${p}`, id: 'x', getManifest: () => ({ version: '1' }) },
    };
  }
  const args = { tabId: 9, allowHosts: ['chromewebstore.google.com'], allow: { read: ['chromewebstore.google.com'], interact: [] }, ownOrigins: [] };
  afterEach(() => delete (globalThis as { chrome?: unknown }).chrome);

  it('an empty source gets a screenshot attached, and the note says why', async () => {
    browser(EMPTY, 'ok');
    const r = await handleCommand({ tool: 'read', args });
    expect(r.ok).toBe(true);
    expect(typeof r.data.image).toBe('string');
    expect(r.data.image.length).toBeGreaterThan(0);
    expect(r.data.note).toMatch(/picture of the page is added/);
    expect(r.data.thin).toBeUndefined();
  });
  it('a source with content needs no picture', async () => {
    browser(PAGE, 'ok');
    const r = await handleCommand({ tool: 'read', args });
    expect(r.data.image).toBeUndefined();
  });
  it('when the browser refuses the picture too, the text still comes with an honest note', async () => {
    browser(EMPTY, 'refused');
    const r = await handleCommand({ tool: 'read', args });
    expect(r.ok).toBe(true);
    expect(r.data.image).toBeUndefined();
    expect(r.data.note).toMatch(/picture could not be taken either/);
  });
});
