import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Cdp } from './cdp';
import { MockSio } from './mock-sio';
import { ExtensionService } from './extension.service';

/**
 * A real Chromium loads the REAL generated package and walks the Connect handshake against a fake server:
 * page → (content script) → service worker → token exchange → connected; then the popup lists projects with the stored token.
 * Skipped unless CHROMIUM_BIN points to a Chromium / Chrome for Testing (branded Chrome ≥ 137 ignores --load-extension).
 *   CHROMIUM_BIN=~/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium pnpm vitest run extension-e2e
 */
const BIN = process.env.CHROMIUM_BIN;

const PAGE = (port: number) => `<!doctype html><title>fake dashboard</title><body>fake dashboard<script>
const log = (o) => fetch('/report', { method: 'POST', body: JSON.stringify(o) });
let paired = false;
window.addEventListener('message', (e) => {
  if (e.source !== window || !e.data || e.data.source !== 'aigentron-extension') return;
  log({ from: 'page', msg: e.data });
  if (e.data.type === 'ready' && !e.data.connected && !paired) {
    paired = true;
    window.postMessage({ source: 'aigentron-dashboard', type: 'pair', code: 'GOOD-CODE', apiOrigin: location.origin }, location.origin);
  }
});
window.postMessage({ source: 'aigentron-dashboard', type: 'ping' }, location.origin);
setTimeout(() => window.postMessage({ source: 'aigentron-dashboard', type: 'ping' }, location.origin), 1500);
</script>`;

// fake credentials for the redaction checks, built from pieces so no secret scanner sees a key-looking literal in the source
const FAKE_TOKEN = ['abcdefghijklmnop', '123456'].join('');
const FAKE_QUERY_SECRET = ['VERYSECRET', 'VALUE123'].join('');

describe.skipIf(!BIN)('the generated extension in a real Chromium', () => {
  let server: Server | undefined;
  let sites: Server | undefined;
  let chrome: ChildProcess | undefined;
  afterAll(() => {
    chrome?.kill('SIGKILL');
    server?.close();
    sites?.close();
  });

  it('connects through the page handshake and then calls the API with its own token', async () => {
    const events: { from: string; msg?: Record<string, unknown>; path?: string; auth?: string | null; body?: unknown; ctype?: string; bytes?: number; raw?: string }[] = [];
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        const url = req.url ?? '';
        if (url === '/') return void res.setHeader('content-type', 'text/html').end(PAGE(0));
        if (url === '/form') return void res.setHeader('content-type', 'text/html').end('<!doctype html><title>Contact form</title><body><h1>Contact us</h1><form id="contact" action="/form-submit" method="post"><label for="name">Your name</label><input id="name" name="name"><label for="pw">Password</label><input id="pw" name="pw" type="password"><label for="topic">Topic</label><select id="topic" name="topic"><option value="a">Alpha</option><option value="b">Beta</option></select><button type="button" id="more" onclick="document.getElementById(\'extra\').hidden=false">Show more</button><p id="extra" hidden>Extra info revealed</p><button type="submit">Send message</button></form></body>');
        if (url === '/form-submit') {
          events.push({ from: 'api', path: 'POST /form-submit', raw: body } as never);
          return void res.setHeader('content-type', 'text/html').end('<!doctype html><title>Thanks</title><body><h1>Thank you</h1></body>');
        }
        if (url === '/article') return void res.setHeader('content-type', 'text/html').end('<!doctype html><html lang="en"><title>Test article</title><body><nav>menu menu menu</nav><article><h1>Heading of the article</h1><p>' + 'The quick brown fox jumps over the lazy dog. '.repeat(20) + '</p></article><footer>footer</footer></body></html>');
        if (url === '/report') {
          events.push({ from: 'page', msg: (JSON.parse(body) as { msg: Record<string, unknown> }).msg });
          return void res.end('ok');
        }
        const json = (req.headers['content-type'] ?? '').includes('json');
        events.push({ from: 'api', path: `${req.method} ${url}`, auth: req.headers.authorization ?? null, body: body && json ? JSON.parse(body) : undefined, ctype: req.headers['content-type'] ?? '', bytes: Buffer.byteLength(body) });
        res.setHeader('content-type', 'application/json');
        if (url === '/api/extension/token') {
          const b = JSON.parse(body) as { code?: string };
          if (b.code !== 'GOOD-CODE') return void res.writeHead(401).end('{"message":"bad code"}');
          return void res.end(JSON.stringify({ token: 'tok-123', user: { id: 'u1', displayName: 'Olga', role: 'operator' }, serverVersion: '0.1.104' }));
        }
        if (req.headers.authorization !== 'Bearer tok-123') return void res.writeHead(401).end('{"message":"no"}');
        if (url === '/api/projects') return void res.end(JSON.stringify([{ id: 'p1', slug: 'main', name: 'Main project', archivedAt: null, isDefault: true, defaultAgent: 'pm', pinnedAgents: null }]));
        if (url === '/api/agents') return void res.end(JSON.stringify([{ name: 'pm', description: 'lead' }, { name: 'admin', description: 'admin' }, { name: 'researcher', description: 'r' }]));
        if (url === '/api/extension/me') return void res.end(JSON.stringify({ user: { id: 'u1', displayName: 'Olga', role: 'operator' }, serverVersion: 'dev', extensionVersion: '9.9.9' }));
        if (url === '/api/voice') return void res.end(JSON.stringify({ stt: null, tts: null, sttReady: true, ttsReady: false }));
        if (url === '/api/voice/transcribe') return void res.end(JSON.stringify({ text: 'hello voice' }));
        if (url === '/api/approvals?status=pending') return void res.end('[]');
        if (url === '/api/questions?status=pending') return void res.end('[]');
        if (url.startsWith('/api/tasks?')) return void res.end(JSON.stringify({ items: [{ id: 't1', title: 'Fix the login button', status: 'review', agentName: 'pm', updatedAt: new Date().toISOString() }, { id: 't2', title: 'Old chore', status: 'done', agentName: 'coder', updatedAt: '2025-01-01T00:00:00Z' }], total: 2, page: 1, pageSize: 30 }));
        if (url === '/api/tasks/t1/transcript') return void res.end(JSON.stringify(panelTranscript));
        if (url === '/api/tasks/t1/follow-up') {
          panelTranscript.push({ id: 'e3', taskId: 't1', seq: 3, kind: 'prompt', text: (JSON.parse(body) as { prompt: string }).prompt, createdAt: new Date().toISOString() });
          return void res.end('{"ok":true}');
        }
        if (url === '/api/tasks/t1') return void res.end(JSON.stringify({ id: 't1', title: 'Fix the login button', project: { slug: 'main', name: 'Main project' } }));
        if (/^\/api\/approvals\/[\w-]+\/decision$/.test(url) || /^\/api\/questions\/[\w-]+\/answer$/.test(url)) return void res.end('{"ok":true}');
        if (url.startsWith('/api/knowledge')) return void res.end(JSON.stringify([{ name: 'docs' }]));
        if (url === '/api/extension/clip') return void res.end(JSON.stringify({ kind: 'task', id: 't1', path: '/tasks/t1' }));
        res.writeHead(404).end('{}');
      });
    });
    const sio = new MockSio(server, 'tok-123');
    const panelTranscript: object[] = [
      { id: 'e1', taskId: 't1', seq: 1, kind: 'prompt', text: 'Fix the login button', createdAt: '2026-01-01T10:00:00Z' },
      { id: 'e2', taskId: 't1', seq: 2, kind: 'result', text: 'Done.\n\n- changed `Login.tsx`\n- **tests** pass\n\n<img src=x onerror=alert(1)>', createdAt: '2026-01-01T10:05:00Z' },
    ];
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const origin = `http://127.0.0.1:${port}`;

    // build the real package with the real service (a fake config pointing at the shipped template and a temp secrets dir)
    const secrets = mkdtempSync(join(tmpdir(), 'ext-secrets-'));
    const svc = new ExtensionService({ secretsDir: secrets, extensionDir: (() => {
      const out = mkdtempSync(join(tmpdir(), 'ext-tpl-'));
      execFileSync(process.execPath, [join(__dirname, '..', '..', '..', 'extension', 'build.mjs'), '--out', out], { stdio: 'pipe' });
      return out;
    })() } as never);
    const { zip, extensionId } = await svc.buildZip([origin]);
    const dir = mkdtempSync(join(tmpdir(), 'ext-pkg-'));
    writeFileSync(join(dir, 'pkg.zip'), zip);
    execFileSync('unzip', ['-q', join(dir, 'pkg.zip'), '-d', join(dir, 'x')]);
    // «Show cards on any page» is an OPTIONAL permission a person grants with a click in the popup; a test cannot click it, so its own copy has it up front
    const mf = JSON.parse(readFileSync(join(dir, 'x', 'manifest.json'), 'utf8')) as { host_permissions: string[]; optional_host_permissions?: string[] };
    expect(mf.optional_host_permissions).toEqual(['<all_urls>']);
    mf.host_permissions.push('<all_urls>');
    writeFileSync(join(dir, 'x', 'manifest.json'), JSON.stringify(mf));

    const debugPort = 20000 + Math.floor(Math.random() * 20000);
    const profile = mkdtempSync(join(tmpdir(), 'ext-profile-'));
    const args = [`--user-data-dir=${profile}`, `--load-extension=${join(dir, 'x')}`, '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--remote-debugging-port=${debugPort}`, `${origin}/`];
    chrome = spawn(BIN!, args, { stdio: 'ignore' });

    const until = async (cond: () => boolean, ms: number, what: string) => {
      const t0 = Date.now();
      while (!cond()) {
        if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}; events: ${JSON.stringify(events)}`);
        await new Promise((r) => setTimeout(r, 200));
      }
    };

    // 1. the content script announced itself on the server's own page, not connected yet
    await until(() => events.some((e) => e.msg?.type === 'ready'), 30_000, 'the extension to announce itself');
    expect(events.find((e) => e.msg?.type === 'ready')!.msg).toMatchObject({ extensionId, connected: false });
    // 2. the page handed over the code → the worker exchanged it (with a device label) → the page was told
    await until(() => events.some((e) => e.msg?.type === 'paired'), 20_000, 'the pairing answer');
    expect(events.find((e) => e.msg?.type === 'paired')!.msg).toMatchObject({ ok: true, user: 'Olga' });
    const exchange = events.find((e) => e.path === 'POST /api/extension/token')!;
    expect((exchange.body as { code: string; device: string }).code).toBe('GOOD-CODE');
    expect(typeof (exchange.body as { device: string }).device).toBe('string');
    // 3. a later announce says connected
    await until(() => events.some((e) => e.msg?.type === 'ready' && e.msg.connected === true), 10_000, 'the connected announcement');
    // 4. the popup (same profile) lists the projects through the worker with the stored token
    const opened = await fetch(`http://127.0.0.1:${debugPort}/json/new?chrome-extension://${extensionId}/popup.html`, { method: 'PUT' });
    expect(opened.ok).toBe(true);
    await until(() => events.some((e) => e.path === 'GET /api/projects'), 30_000, 'the popup to load the projects');
    expect(events.find((e) => e.path === 'GET /api/projects')!.auth).toBe('Bearer tok-123');

    // 5. "send this page" (no toolbar click here, so no screenshot): the compose page captures the article tab — title, the readable text — and the person presses Send
    const tab = (await (await fetch(`http://127.0.0.1:${debugPort}/json/new?${origin}/article`, { method: 'PUT' })).json()) as { id: string };
    await new Promise((r) => setTimeout(r, 1500));
    const open = async (url: string) => {
      const t = (await (await fetch(`http://127.0.0.1:${debugPort}/json/new?${url}`, { method: 'PUT' })).json()) as { webSocketDebuggerUrl: string };
      return Cdp.connect(t.webSocketDebuggerUrl);
    };
    const waitFor = async (page: Cdp, js: string, what: string) => {
      const t0 = Date.now();
      for (;;) {
        if (await page.eval<boolean>(js).catch(() => false)) return; // the page may still be loading
        if (Date.now() - t0 > 40_000) throw new Error(`compose page: timeout waiting for ${what}; body: ${await page.eval<string>('document.body.innerText.slice(0,400)')}`);
        await new Promise((r) => setTimeout(r, 200));
      }
    };
    const formReady = "!!document.getElementById('project') && document.getElementById('project').options.length > 0 && !!document.querySelector('#source .title')";

    const pageA = await open(`chrome-extension://${extensionId}/compose.html?find=${encodeURIComponent(`${origin}/article*`)}&kind=page`);
    try {
      await waitFor(pageA, formReady, 'the form');
      expect(await pageA.eval<string>("document.querySelector('#source .title').textContent")).toBe('Test article');
      expect(await pageA.eval<string>("document.getElementById('project').value")).toBe('main');
      expect(await pageA.eval<string[]>("[...document.getElementById('agent').options].map((o) => o.value)")).toEqual(['', 'pm', 'researcher']); // admin is not offered
      await pageA.eval("(() => { const t = document.getElementById('prompt'); t.value = 'Summarise this article'; t.dispatchEvent(new Event('input')); })()");
      await waitFor(pageA, "!document.getElementById('send').disabled", 'the Send button');
      await pageA.eval("document.getElementById('send').click()");
      await waitFor(pageA, "!document.getElementById('done').hidden", 'the confirmation');
    } finally {
      pageA.close();
    }
    const clipA = events.filter((e) => e.path === 'POST /api/extension/clip')[0]!;
    expect(clipA.auth).toBe('Bearer tok-123');
    const bodyA = clipA.body as { mode: string; project: string; prompt: string; page: { url: string; title: string; text?: string }; screenshot?: string };
    expect(bodyA).toMatchObject({ mode: 'task', project: 'main', prompt: 'Summarise this article', page: { url: `${origin}/article`, title: 'Test article' } });
    expect(bodyA.page.text).toContain('quick brown fox');
    expect(bodyA.page.text).toContain('Heading of the article'); // the <article>, not the menu
    expect(bodyA.page.text).not.toContain('menu menu');
    expect(bodyA.screenshot).toBeUndefined();

    // 6. a screenshot (a draft with a picture, as a toolbar click would make it): the person marks a rectangle; the picture goes out as a JPEG WITH the mark
    const seed = await open(`chrome-extension://${extensionId}/popup.html`);
    let draftId: string;
    try {
      await waitFor(seed, "location.protocol === 'chrome-extension:' && !!window.chrome?.storage?.session && document.readyState === 'complete'", 'the extension page');
      draftId = await seed.eval<string>(`(async () => {
        const c = document.createElement('canvas'); c.width = 400; c.height = 300;
        const g = c.getContext('2d'); g.fillStyle = '#ffffff'; g.fillRect(0, 0, 400, 300); g.fillStyle = '#2255cc'; g.fillRect(40, 40, 320, 220);
        const id = 'seed-' + Math.random().toString(36).slice(2);
        await chrome.storage.session.set({ ['draft:' + id]: { id, kind: 'screenshot', tabId: 1, url: '${origin}/article', title: 'Test article', selection: '', text: 'some text', linkUrl: '', screenshot: c.toDataURL('image/png'), note: '', createdAt: Date.now() } });
        return id;
      })()`);
    } finally {
      seed.close();
    }
    const pageB = await open(`chrome-extension://${extensionId}/compose.html?draft=${draftId}`);
    try {
      await waitFor(pageB, formReady, 'the form (screenshot)');
      expect(await pageB.eval<boolean>("!document.getElementById('shotCard').hidden")).toBe(true); // a screenshot draft starts with the picture on
      await pageB.eval(`(() => {
        const c = document.getElementById('canvas');
        const b = c.getBoundingClientRect();
        const at = (fx, fy) => ({ clientX: b.left + b.width * fx, clientY: b.top + b.height * fy, pointerId: 1, bubbles: true });
        c.dispatchEvent(new PointerEvent('pointerdown', at(0.25, 0.25)));
        c.dispatchEvent(new PointerEvent('pointermove', at(0.75, 0.75)));
        c.dispatchEvent(new PointerEvent('pointerup', at(0.75, 0.75)));
      })()`);
      // the mark is drawn: the border of the rectangle at 25% / 25% is red now (it was white before)
      const px = await pageB.eval<number[]>("(() => { const c = document.getElementById('canvas'); return [...c.getContext('2d').getImageData(Math.round(c.width * 0.25), Math.round(c.height * 0.25) + 20, 1, 1).data]; })()");
      expect(px[0]).toBeGreaterThan(200);
      expect(px[1]).toBeLessThan(90);
      await pageB.eval("(() => { const t = document.getElementById('prompt'); t.value = 'What is marked?'; t.dispatchEvent(new Event('input')); })()");
      await waitFor(pageB, "!document.getElementById('send').disabled", 'the Send button (screenshot)');
      await pageB.eval("document.getElementById('send').click()");
      await waitFor(pageB, "!document.getElementById('done').hidden", 'the confirmation (screenshot)');
    } finally {
      pageB.close();
    }
    const clipB = events.filter((e) => e.path === 'POST /api/extension/clip')[1]!;
    const bodyB = clipB.body as { prompt: string; screenshot?: string; page: { text?: string } };
    expect(bodyB.prompt).toBe('What is marked?');
    expect(typeof bodyB.screenshot).toBe('string');
    expect(Buffer.from(bodyB.screenshot!, 'base64').subarray(0, 3).toString('hex')).toBe('ffd8ff'); // a JPEG
    expect(bodyB.page.text).toBeUndefined(); // the text was not ticked: only what the person chose is sent

    // 7. the realtime connection: the extension joined the socket with its device token and reported that the browser is in front (or away)
    await until(() => sio.authSeen.length > 0, 20_000, 'the socket connect');
    expect(sio.authSeen[0]).toMatchObject({ token: 'tok-123', version: expect.stringMatching(/^\d+(\.\d+)*$/) }); // the extension also says which version it is
    await until(() => sio.received.some((e) => e.name === 'client:focus' || e.name === 'client:blur'), 20_000, 'the presence report');

    // 8. an approval arrives while the person is on an ordinary web page: a card is drawn there (closed shadow root, top layer)
    const normal = (await (await fetch(`http://127.0.0.1:${debugPort}/json/new?http://localhost:${port}/article`, { method: 'PUT' })).json()) as { id: string; webSocketDebuggerUrl: string };
    await fetch(`http://127.0.0.1:${debugPort}/json/activate/${normal.id}`);
    const web = await Cdp.connect(normal.webSocketDebuggerUrl);
    type DomNode = { nodeId: number; localName?: string; nodeValue?: string; children?: DomNode[]; shadowRoots?: DomNode[] };
    const find = async (pred: (n: DomNode) => boolean): Promise<number | null> => {
      const { root } = await web.call<{ root: DomNode }>('DOM.getDocument', { depth: -1, pierce: true });
      const walk = (n: DomNode): DomNode | null => {
        if (pred(n)) return n;
        for (const c of [...(n.children ?? []), ...(n.shadowRoots ?? [])]) {
          const r = walk(c);
          if (r) return r;
        }
        return null;
      };
      return walk(root)?.nodeId ?? null;
    };
    const button = (label: string) => find((n) => n.localName === 'button' && n.children?.[0]?.nodeValue === label);
    const waitButton = async (label: string, present = true) => {
      const t0 = Date.now();
      for (;;) {
        if (((await button(label)) !== null) === present) return;
        if (Date.now() - t0 > 20_000) throw new Error(`timeout: button "${label}" ${present ? 'never' : 'still'} shown; events: ${JSON.stringify(events.slice(-4))}`);
        await new Promise((r) => setTimeout(r, 250));
      }
    };
    const trustedClick = async (label: string) => {
      const nodeId = (await button(label))!;
      const { model } = await web.call<{ model: { content: number[] } }>('DOM.getBoxModel', { nodeId });
      const [x1, y1, , , x3, y3] = model.content as [number, number, number, number, number, number];
      const x = (x1 + x3) / 2;
      const y = (y1 + y3) / 2;
      await web.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await web.call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await web.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    };
    try {
      sio.push('approval:created', { approval: { id: 'ap1', taskId: 't1', toolName: 'Bash', summary: '$ npm test && rm -rf dist', reason: 'recursive force remove (rm -rf)', status: 'pending', createdAt: new Date().toISOString(), needsDashboard: false } });
      await waitButton('Approve');
      const text = await web.eval<string>("document.documentElement.innerText");
      expect(text).not.toContain('npm test'); // the card is in a CLOSED shadow root: the page cannot read it
      // an untrusted click (what a page script could produce) does nothing
      await new Promise((r) => setTimeout(r, 600));
      const nodeId = (await button('Approve'))!;
      const { object } = await web.call<{ object: { objectId: string } }>('DOM.resolveNode', { nodeId });
      await web.call('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: 'function () { this.click(); }' });
      await new Promise((r) => setTimeout(r, 800));
      expect(events.some((e) => e.path?.includes('/decision'))).toBe(false);
      // a real click decides, with the extension's token
      await trustedClick('Approve');
      await until(() => events.some((e) => e.path === 'POST /api/approvals/ap1/decision'), 15_000, 'the decision');
      const decision = events.find((e) => e.path === 'POST /api/approvals/ap1/decision')!;
      expect(decision.body).toEqual({ decision: 'approve' });
      expect(decision.auth).toBe('Bearer tok-123');
      // the server says it is resolved: the card goes away
      sio.push('approval:resolved', { approvalId: 'ap1', taskId: 't1' });
      await waitButton('Approve', false);

      // 9. a request that only the dashboard may decide: shown, but without Approve / Deny
      sio.push('approval:created', { approval: { id: 'ap2', taskId: 't1', toolName: 'Bash', summary: '$ git merge feature', reason: 'a merge', status: 'pending', createdAt: new Date().toISOString(), needsDashboard: true } });
      await waitButton('Open in the dashboard');
      expect(await button('Approve')).toBeNull();
      expect(await button('Deny')).toBeNull();
      sio.push('approval:resolved', { approvalId: 'ap2', taskId: 't1' });
      await waitButton('Open in the dashboard', false);

      // 10. a question with answer buttons
      sio.push('question:created', { question: { id: 'q9', taskId: 't1', question: 'Which database?', options: ['Postgres', 'SQLite'], allowText: false, multiple: false, createdAt: new Date().toISOString() } });
      await waitButton('SQLite');
      await new Promise((r) => setTimeout(r, 600));
      await trustedClick('SQLite');
      await until(() => events.some((e) => e.path === 'POST /api/questions/q9/answer'), 15_000, 'the answer');
      expect(events.find((e) => e.path === 'POST /api/questions/q9/answer')!.body).toEqual({ index: 1 });
    } finally {
      web.close();
      sio.close();
    }

    // 11. the side panel: the task list, a conversation with the agent's answer (rendered safely), a follow-up, and a live message from the socket
    const panel = await open(`chrome-extension://${extensionId}/panel.html`);
    try {
      await waitFor(panel, "document.querySelectorAll('.task').length === 2 || (document.getElementById('main') && /Nothing|bad/.test(document.getElementById('main').className))", 'the task list');
      // «Needs me» is the default filter, but the fake server returns both rows; the one that needs the person comes first
      expect(await panel.eval<string[]>("[...document.querySelectorAll('.task .t')].map((n) => n.textContent)")).toEqual(['Fix the login button', 'Old chore']);
      expect(await panel.eval<string>("document.querySelector('.task .chip').textContent")).toBe('ready — confirm');
      await panel.eval("document.querySelector('.task').click()");
      await waitFor(panel, "document.querySelectorAll('#conv .msg').length === 2", 'the conversation');
      expect(await panel.eval<string>("document.querySelector('#conv .msg.you').textContent")).toContain('Fix the login button');
      // the answer is Markdown rendered from text nodes: a list, inline code, bold — and the HTML an agent could write stays text
      expect(await panel.eval<number>("document.querySelectorAll('#conv .msg.result li').length")).toBe(2);
      expect(await panel.eval<string>("document.querySelector('#conv .msg.result code').textContent")).toBe('Login.tsx');
      expect(await panel.eval<number>("document.querySelectorAll('#conv img').length")).toBe(0);
      expect(await panel.eval<string>("document.querySelector('#conv .msg.result').textContent")).toContain('<img src=x');
      // the panel joined the task's room
      await until(() => sio.received.some((e) => e.name === 'subscribe:task' && e.args[0] === 't1'), 15_000, 'subscribe:task');
      // a follow-up goes to the server and appears in the conversation
      await panel.eval("(() => { const t = document.querySelector('.composer textarea'); t.value = 'Please also add a test'; })()");
      await panel.eval("document.querySelector('.composer .primary').click()");
      await until(() => events.some((e) => e.path === 'POST /api/tasks/t1/follow-up'), 15_000, 'the follow-up');
      expect(events.find((e) => e.path === 'POST /api/tasks/t1/follow-up')!.body).toEqual({ prompt: 'Please also add a test' });
      await waitFor(panel, "document.querySelectorAll('#conv .msg').length === 3", 'the follow-up in the conversation');
      // a live message from the agent arrives over the socket
      sio.push('agent:log', { taskId: 't1', agentSessionId: 's', kind: 'assistant', text: 'Working on the test now', seq: 10, ts: new Date().toISOString() });
      await waitFor(panel, "document.getElementById('conv').textContent.includes('Working on the test now')", 'the live message');
    } finally {
      panel.close();
    }

    // 12. «Report a bug»: record on the article tab, produce problems, point at an element, finish → the compose page → a task with the collected data
    const targets = (await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()) as { id: string; url: string; webSocketDebuggerUrl: string }[];
    const article = await Cdp.connect(targets.find((t) => t.id === tab.id)!.webSocketDebuggerUrl);
    const ext = await open(`chrome-extension://${extensionId}/popup.html`);
    try {
      await waitFor(ext, "location.protocol === 'chrome-extension:' && !!window.chrome?.runtime?.sendMessage && document.readyState === 'complete'", 'the extension page (bug)');
      const started = await ext.eval<{ ok: boolean; tabId: number }>(`chrome.runtime.sendMessage({ type: 'bug-start', find: '${origin}/article*' })`);
      expect(started.ok).toBe(true);
      // the problems: a logged error with a token in it, an uncaught error, a rejected promise, a failing request with a query string
      await article.eval(`(() => {
        console.error('Boom: token=${FAKE_TOKEN} failed');
        setTimeout(() => { throw new Error('Async failure'); }, 0);
        Promise.reject(new Error('Rejected promise'));
        return fetch('/missing-endpoint?secret=${FAKE_QUERY_SECRET}&x=1').catch(() => null);
      })()`);
      await new Promise((r) => setTimeout(r, 500));
      const peek = await ext.eval<{ recording: boolean; console: number; network: number; errors: number }>(`chrome.runtime.sendMessage({ type: 'bug-peek', tabId: ${started.tabId} })`);
      expect(peek).toMatchObject({ recording: true });
      expect(peek.console).toBeGreaterThanOrEqual(1);
      expect(peek.network).toBeGreaterThanOrEqual(1);
      expect(peek.errors).toBeGreaterThanOrEqual(2);
      // pick the heading: the picker waits for a click on the page
      const picked = ext.eval<{ ok: boolean; element: { selector: string; tag: string; text: string; styles: Record<string, string> } | null }>(`chrome.runtime.sendMessage({ type: 'bug-pick', tabId: ${started.tabId} })`);
      type N = { nodeId: number; localName?: string; nodeValue?: string; children?: N[]; shadowRoots?: N[] };
      const findIn = async (pred: (n: N) => boolean): Promise<number | null> => {
        const { root } = await article.call<{ root: N }>('DOM.getDocument', { depth: -1, pierce: true });
        const walk = (n: N): N | null => {
          if (pred(n)) return n;
          for (const c of [...(n.children ?? []), ...(n.shadowRoots ?? [])]) {
            const r = walk(c);
            if (r) return r;
          }
          return null;
        };
        return walk(root)?.nodeId ?? null;
      };
      const t0 = Date.now();
      while ((await findIn((n) => n.nodeValue?.startsWith('Click the element you mean') ?? false)) === null) {
        if (Date.now() - t0 > 15_000) throw new Error('the element picker did not appear');
        await new Promise((r) => setTimeout(r, 200));
      }
      const h1 = (await findIn((n) => n.localName === 'h1'))!;
      const { model } = await article.call<{ model: { content: number[] } }>('DOM.getBoxModel', { nodeId: h1 });
      const [hx1, hy1, , , hx3, hy3] = model.content as [number, number, number, number, number, number];
      const cx = (hx1 + hx3) / 2;
      const cy = (hy1 + hy3) / 2;
      await article.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy });
      await article.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 });
      await article.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 });
      const pick = await picked;
      expect(pick.element).toMatchObject({ tag: 'h1', text: 'Heading of the article' });
      expect(pick.element!.selector).toContain('h1');
      expect(pick.element!.styles.display).toBeTruthy();
      // finish: a draft with the data (no new tab here)
      const fin = await ext.eval<{ ok: boolean; id: string }>(`chrome.runtime.sendMessage({ type: 'bug-finish', tabId: ${started.tabId}, element: ${JSON.stringify(pick.element)}, open: false })`);
      expect(fin.ok).toBe(true);
      const bugPage = await open(`chrome-extension://${extensionId}/compose.html?draft=${fin.id}`);
      try {
        await waitFor(bugPage, formReady, 'the form (bug)');
        expect(await bugPage.eval<string>("document.getElementById('includes').textContent")).toContain('the bug report data');
        expect(await bugPage.eval<string>("document.getElementById('agent').value")).toBe('');
        await bugPage.eval("(() => { const t = document.getElementById('prompt'); t.value = 'The heading looks wrong'; t.dispatchEvent(new Event('input')); })()");
        await waitFor(bugPage, "!document.getElementById('send').disabled", 'the Send button (bug)');
        await bugPage.eval("document.getElementById('send').click()");
        await waitFor(bugPage, "!document.getElementById('done').hidden", 'the confirmation (bug)');
      } finally {
        bugPage.close();
      }
    } finally {
      ext.close();
      article.close();
    }
    const bugClip = events.filter((e) => e.path === 'POST /api/extension/clip').pop()!;
    const bb = bugClip.body as { prompt: string; bug: { console: { level: string; text: string }[]; network: { url: string; status: number }[]; errors: { message: string }[]; element: { selector: string; tag: string }; env: { userAgent: string; viewport: { w: number } } } };
    expect(bb.prompt).toBe('The heading looks wrong');
    expect(bb.bug.console.some((c) => c.level === 'error' && c.text.includes('Boom') && !c.text.includes(FAKE_TOKEN))).toBe(true); // the token is redacted
    expect(bb.bug.errors.some((e) => e.message.includes('Async failure'))).toBe(true);
    expect(bb.bug.errors.some((e) => e.message.includes('Rejected promise'))).toBe(true);
    const failed = bb.bug.network.find((n) => n.url.endsWith('/missing-endpoint'))!;
    expect(failed.status).toBeGreaterThanOrEqual(400);
    expect(failed.url).not.toContain(FAKE_QUERY_SECRET); // the query string never leaves the page
    expect(bb.bug.element).toMatchObject({ tag: 'h1' });
    expect(bb.bug.env.userAgent).toContain('Chrome');
    expect(bb.bug.env.viewport.w).toBeGreaterThan(100);

    // 13. dictation: the microphone button records (a fake audio device here), the recording goes to the server, the text lands in the box
    const voicePage = await open(`chrome-extension://${extensionId}/compose.html?find=${encodeURIComponent(`${origin}/article*`)}&kind=page`);
    try {
      await waitFor(voicePage, formReady, 'the form (voice)');
      await waitFor(voicePage, "!!document.querySelector('#micSlot button')", 'the microphone button');
      await voicePage.eval("document.querySelector('#micSlot button').click()");
      await waitFor(voicePage, "document.querySelector('#micSlot button').textContent === '⏹'", 'the recording to start');
      await new Promise((r) => setTimeout(r, 1500));
      await voicePage.eval("document.querySelector('#micSlot button').click()");
      await waitFor(voicePage, "document.getElementById('prompt').value.includes('hello voice')", 'the recognised text');
    } finally {
      voicePage.close();
    }
    const dictated = events.find((e) => e.path === 'POST /api/voice/transcribe')!;
    expect(dictated.auth).toBe('Bearer tok-123');
    expect(dictated.ctype).toContain('audio/webm');
    expect(dictated.bytes).toBeGreaterThan(500);

    // 13b. a screenshot to an EXISTING task (as the side panel's "📷 Screenshot" opens it): the task is chosen already, the message goes to it, no project is sent
    const seed2 = await open(`chrome-extension://${extensionId}/popup.html`);
    let draft2: string;
    try {
      await waitFor(seed2, "location.protocol === 'chrome-extension:' && !!window.chrome?.storage?.session && document.readyState === 'complete'", 'the extension page (2)');
      draft2 = await seed2.eval<string>(`(async () => {
        const c = document.createElement('canvas'); c.width = 200; c.height = 120;
        const g = c.getContext('2d'); g.fillStyle = '#eeeeee'; g.fillRect(0, 0, 200, 120);
        const id = 'seed-' + Math.random().toString(36).slice(2);
        await chrome.storage.session.set({ ['draft:' + id]: { id, kind: 'screenshot', tabId: 1, url: '${origin}/article', title: 'Test article', selection: '', text: '', linkUrl: '', screenshot: c.toDataURL('image/png') } });
        return id;
      })()`);
    } finally {
      seed2.close();
    }
    // (DevTools' /json/new cuts a URL at its first `&`: the second parameter is added from inside the tab)
    const toTask = await open(`chrome-extension://${extensionId}/compose.html?draft=${draft2}`);
    try {
      await waitFor(toTask, "document.readyState === 'complete' && !!document.getElementById('mode')", 'the page to load');
      await toTask.eval(`location.search = '?draft=${draft2}&task=t1'`);
      await new Promise((r) => setTimeout(r, 800));
      await waitFor(toTask, formReady, 'the form (to a task)');
      await waitFor(toTask, "document.getElementById('mode').value === 'followup' && !!document.querySelector('.taskItem[aria-selected=\"true\"]')", 'the task to be chosen');
      expect(await toTask.eval<string>("document.querySelector('.taskItem[aria-selected=\"true\"] .t').textContent")).toBe('Fix the login button');
      expect(await toTask.eval<boolean>("document.getElementById('projectWrap').hidden && document.getElementById('agentWrap').hidden && document.getElementById('kbWrap').hidden")).toBe(true);
      expect(await toTask.eval<number>("document.querySelectorAll('.taskItem').length")).toBe(2);
      await toTask.eval("(() => { const t = document.getElementById('prompt'); t.value = 'The layout is still off'; t.dispatchEvent(new Event('input')); })()");
      await waitFor(toTask, "!document.getElementById('send').disabled", 'the Send button (to a task)');
      await toTask.eval("document.getElementById('send').click()");
      await waitFor(toTask, "!document.getElementById('done').hidden", 'the confirmation (to a task)');
    } finally {
      toTask.close();
    }
    const clipT = events.filter((e) => e.path === 'POST /api/extension/clip').pop()!;
    const bodyT = clipT.body as { mode: string; taskId: string; project?: string; prompt: string; screenshot?: string };
    expect(bodyT).toMatchObject({ mode: 'followup', taskId: 't1', prompt: 'The layout is still off' });
    expect(bodyT.project).toBeUndefined();
    expect(typeof bodyT.screenshot).toBe('string');

    // 14. updating: the server offers a newer extension version; the popup says so, and the update page offers it (the folder picker itself needs a person)
    const upd = await open(`chrome-extension://${extensionId}/popup.html`);
    try {
      await waitFor(upd, "document.body.innerText.includes('Update available')", 'the update notice in the popup');
      expect(await upd.eval<string>("document.querySelector('.bell strong').textContent")).toContain('→ 9.9.9');
    } finally {
      upd.close();
    }
    const updPage = await open(`chrome-extension://${extensionId}/update.html`);
    try {
      await waitFor(updPage, "document.getElementById('state')?.innerText.includes('Version 9.9.9 is available')", 'the update page');
      expect(await updPage.eval<boolean>("!!document.querySelector('#state button.primary')")).toBe(true);
    } finally {
      updPage.close();
    }

    // 15. browser control: commands from the server run in the agent's OWN window; policy and grants are enforced in the browser too
    // the pages agents visit are on ANOTHER site than the Aigentron server the extension is connected to (that one is off limits)
    sites = createServer((req, res) => server!.emit('request', req, res));
    await new Promise<void>((r) => sites!.listen(0, '127.0.0.1', r));
    const sitePort = (sites.address() as { port: number }).port;
    const lh = `localhost:${sitePort}`; // grants are kept per host and port
    const command = async (tool: string, args: Record<string, unknown>) => {
      const id = `c${Math.random().toString(36).slice(2)}`;
      sio.push('ext:command', { id, tool, args, taskId: 't1' });
      await until(() => sio.received.some((e) => e.name === 'ext:result' && (e.args[0] as { id: string }).id === id), 30_000, `the answer to ${tool}`);
      return sio.received.find((e) => e.name === 'ext:result' && (e.args[0] as { id: string }).id === id)!.args[0] as { ok: boolean; data?: Record<string, unknown>; error?: string; needsGrant?: string };
    };
    const own = ['http://127.0.0.1:1']; // the pretend Aigentron server (the test page server above is some other site)
    const articleUrl = `http://localhost:${sitePort}/article`;

    // not granted yet → the browser asks the server for a grant instead of opening anything
    expect(await command('open', { url: articleUrl, allowHosts: [], ownOrigins: own })).toMatchObject({ ok: false, needsGrant: lh });
    // sites that are never allowed, and the Aigentron server itself, are refused even when the server (wrongly) says yes
    expect((await command('open', { url: 'https://paypal.com/x', allowHosts: ['paypal.com'], ownOrigins: own })).error).toContain('Not allowed');
    expect((await command('open', { url: 'http://127.0.0.1:1/article', allowHosts: ['127.0.0.1:1'], ownOrigins: own })).error).toContain('Aigentron server');
    expect((await command('open', { url: 'http://localhost.:1/article', allowHosts: ['localhost:1'], ownOrigins: own })).error).toContain('Aigentron server'); // another spelling of the same machine
    expect((await command('open', { url: 'javascript:alert(1)', allowHosts: [], ownOrigins: own })).error).toContain('not a web address');
    // (the test browser has the access: an unapproved site asks for a grant; the no-access message is covered in lib/agent-access.test.ts)
    expect(await command('open', { url: 'https://example.com', allowHosts: [], ownOrigins: own })).toMatchObject({ ok: false, needsGrant: 'example.com' });

    // granted: a new tab in the agent's window, with a text outline of the page
    const openedTab = await command('open', { url: articleUrl, allowHosts: [lh], ownOrigins: own });
    expect(openedTab.ok, JSON.stringify(openedTab)).toBe(true);
    const agentTab = openedTab.data!.tabId as number;
    expect(openedTab.data!.title).toBe('Test article');
    expect(String(openedTab.data!.text)).toContain('# Heading of the article');
    expect(String(openedTab.data!.text)).toContain('The quick brown fox');
    expect(String(openedTab.data!.text)).not.toContain('menu menu menu'.slice(0, 0) + 'zzz-not-there');
    const listed = await command('tabs', { allowHosts: [lh], ownOrigins: own });
    expect((listed.data!.tabs as { id: number; url: string }[]).map((t) => t.id)).toEqual([agentTab]);
    // read, in a page of text
    const read = await command('read', { tabId: agentTab, offset: 0, allowHosts: [lh], ownOrigins: own });
    expect(read.ok).toBe(true);
    expect(String(read.data!.text)).toContain('Heading of the article');
    expect(read.data!.more).toBe(false);
    // a tab that is not the agent's (the person's own tabs) cannot be named
    expect((await command('snapshot', { tabId: 999999, allowHosts: [lh], ownOrigins: own })).error).toContain('not one of yours');
    // the tab is on a site the task was not granted (the server forgot it): needsGrant, with the tab id so the server can retry as a snapshot
    expect(await command('snapshot', { tabId: agentTab, allowHosts: [], ownOrigins: own })).toMatchObject({ ok: false, needsGrant: lh, data: { tabId: agentTab } });
    // a picture of the page
    const shot = await command('screenshot', { tabId: agentTab, allowHosts: [lh], ownOrigins: own });
    expect(shot.ok, JSON.stringify(shot)).toBe(true);
    expect(String(shot.data!.image).startsWith('/9j/')).toBe(true); // a JPEG

    // the frame with Stop is in the agent's tab; a REAL click on it stops the agent
    const tgts = (await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()) as { id: string; type: string; url: string; webSocketDebuggerUrl: string }[];
    let agentPage: Cdp | null = null;
    for (const t of tgts.filter((x) => x.type === 'page' && x.url === articleUrl)) {
      const c = await Cdp.connect(t.webSocketDebuggerUrl);
      const { root } = await c.call<{ root: { nodeId: number; children?: unknown[]; shadowRoots?: unknown[]; nodeValue?: string; localName?: string } }>('DOM.getDocument', { depth: -1, pierce: true });
      const has = JSON.stringify(root).includes('An Aigentron agent is working in this tab');
      if (has) agentPage = c;
      else c.close();
    }
    expect(agentPage, 'the agent\'s tab shows the frame').not.toBeNull();
    try {
      type N = { nodeId: number; localName?: string; nodeValue?: string; children?: N[]; shadowRoots?: N[] };
      const { root } = await agentPage!.call<{ root: N }>('DOM.getDocument', { depth: -1, pierce: true });
      const walk = (n: N): N | null => (n.localName === 'button' && n.children?.[0]?.nodeValue === 'Stop' ? n : ([...(n.children ?? []), ...(n.shadowRoots ?? [])].map(walk).find(Boolean) ?? null));
      const stopBtn = walk(root)!;
      const { model } = await agentPage!.call<{ model: { content: number[] } }>('DOM.getBoxModel', { nodeId: stopBtn.nodeId });
      const [sx1, sy1, , , sx3, sy3] = model.content as [number, number, number, number, number, number];
      const sx = (sx1 + sx3) / 2;
      const sy = (sy1 + sy3) / 2;
      await agentPage!.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: sx, y: sy });
      await agentPage!.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: sx, y: sy, button: 'left', clickCount: 1 });
      await agentPage!.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: sx, y: sy, button: 'left', clickCount: 1 });
    } finally {
      agentPage!.close();
    }
    await until(() => sio.received.some((e) => e.name === 'ext:stop'), 15_000, 'ext:stop');
    expect((await command('snapshot', { tabId: agentTab, allowHosts: [lh], ownOrigins: own })).error).toContain('pressed Stop');
    // allowing agents again (the popup's button) tells the server and the commands work again
    const ctl = await open(`chrome-extension://${extensionId}/popup.html`);
    try {
      await waitFor(ctl, "location.protocol === 'chrome-extension:' && !!window.chrome?.runtime?.sendMessage && document.readyState === 'complete'", 'the extension page (agent)');
      await ctl.eval("chrome.runtime.sendMessage({ type: 'agent-allow' })");
    } finally {
      ctl.close();
    }
    await until(() => sio.received.some((e) => e.name === 'ext:allow'), 15_000, 'ext:allow');
    expect((await command('snapshot', { tabId: agentTab, allowHosts: [lh], ownOrigins: own })).ok).toBe(true);
    // closing the tab
    expect((await command('close', { tabId: agentTab, allowHosts: [lh], ownOrigins: own })).ok).toBe(true);
    expect((await command('tabs', { allowHosts: [], ownOrigins: own })).data!.tabs).toEqual([]);

    // 16. acting on a page: type / select / click in a form — never a password, never a submit without the person
    const formUrl = `http://localhost:${sitePort}/form`;
    const readOnly = { read: [lh], interact: [] as string[] };
    const full = { read: [lh], interact: [lh] };
    const refOf = (text: string, pattern: RegExp): string => {
      const m = text.split('\n').find((l) => pattern.test(l));
      const r = m ? /^\[(e\d+)\]/.exec(m)?.[1] : undefined;
      if (!r) throw new Error(`no element matching ${pattern} in:\n${text}`);
      return r;
    };
    const form = await command('open', { url: formUrl, allowHosts: [lh], allow: readOnly, ownOrigins: own });
    expect(form.ok, JSON.stringify(form)).toBe(true);
    const formTab = form.data!.tabId as number;
    const outline = String(form.data!.text);
    expect(outline).toContain('field type=text label="Your name"');
    expect(outline).toContain('field (password — not shown)');
    expect(outline).toContain('select label="Topic" options: Alpha | Beta');
    expect(outline).toContain('button "Send message"');
    const nameRef = refOf(outline, /label="Your name"/);
    const pwRef = refOf(outline, /password/);
    const topicRef = refOf(outline, /^\[e\d+\] select/);
    const moreRef = refOf(outline, /button "Show more"/);
    const sendRef = refOf(outline, /button "Send message"/);
    // reading is granted, acting is not: the browser says it needs the interact level (and did nothing)
    expect(await command('type', { tabId: formTab, ref: nameRef, text: 'x', allowHosts: [lh], allow: readOnly, ownOrigins: own })).toMatchObject({ ok: false, needsGrant: lh, level: 'interact' });
    const agentForm = async (url: string) => {
      const list = (await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()) as { type: string; url: string; webSocketDebuggerUrl: string }[];
      const t = list.find((x) => x.type === 'page' && x.url === url)!;
      return Cdp.connect(t.webSocketDebuggerUrl);
    };
    let fp = await agentForm(formUrl);
    try {
      // type into the name field: it lands in the page, with the events a framework listens to
      const typed = await command('type', { tabId: formTab, ref: nameRef, text: 'Olga', allowHosts: [lh], allow: full, ownOrigins: own });
      expect(typed.ok, JSON.stringify(typed)).toBe(true);
      expect(await fp.eval<string>("document.getElementById('name').value")).toBe('Olga');
      // never a password
      const pw = await command('type', { tabId: formTab, ref: pwRef, text: 'hunter2', allowHosts: [lh], allow: full, ownOrigins: own });
      expect(pw.ok).toBe(false);
      expect(pw.error).toContain('never fills password');
      expect(await fp.eval<string>("document.getElementById('pw').value")).toBe('');
      // a drop-down; an unknown option says what the options are
      expect((await command('select', { tabId: formTab, ref: topicRef, value: 'Beta', allowHosts: [lh], allow: full, ownOrigins: own })).ok).toBe(true);
      expect(await fp.eval<string>("document.getElementById('topic').value")).toBe('b');
      expect((await command('select', { tabId: formTab, ref: topicRef, value: 'Gamma', allowHosts: [lh], allow: full, ownOrigins: own })).error).toContain('Options: Alpha | Beta');
      // an ordinary button works at once and the page changes
      const more = await command('click', { tabId: formTab, ref: moreRef, allowHosts: [lh], allow: full, ownOrigins: own });
      expect(more.ok, JSON.stringify(more)).toBe(true);
      expect(String(more.data!.text)).toContain('Extra info revealed');
      // the SUBMIT button is not pressed: the browser returns what the person should see
      const submit = await command('click', { tabId: formTab, ref: sendRef, allowHosts: [lh], allow: full, ownOrigins: own });
      expect(submit.ok).toBe(false);
      const ns = (submit as unknown as { needsSubmit: { label: string; host: string; action: string; fields: { label: string; value: string }[] } }).needsSubmit;
      expect(ns).toMatchObject({ label: 'Send message', host: 'localhost' });
      expect(ns.action).toContain('/form-submit');
      expect(ns.fields).toEqual(expect.arrayContaining([{ label: 'Your name', value: 'Olga' }, { label: 'Password', value: '••••' }, { label: 'Topic', value: 'b' }]));
      expect(events.some((e) => e.path === 'POST /form-submit')).toBe(false);
      // confirmed (what the server sends after the person's yes): the form goes out — with the typed name, no password
      const sent = await command('click', { tabId: formTab, ref: sendRef, confirmed: true, allowHosts: [lh], allow: full, ownOrigins: own });
      expect(sent.ok, JSON.stringify(sent)).toBe(true);
      await until(() => events.some((e) => e.path === 'POST /form-submit'), 15_000, 'the form submission');
      expect(events.find((e) => e.path === 'POST /form-submit')!.raw).toBe('name=Olga&pw=&topic=b');
      expect(String(sent.data!.text)).toContain('Thank you');
    } finally {
      fp.close();
    }
    // the person's own hands pause the agent: a real click in that tab, and the next action waits
    const again = await command('open', { url: formUrl, allowHosts: [lh], allow: full, ownOrigins: own });
    const tab2 = again.data!.tabId as number;
    const ref2 = refOf(String(again.data!.text), /label="Your name"/);
    fp = await agentForm(formUrl);
    try {
      await fp.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: 5, y: 5, button: 'left', clickCount: 1 });
      await fp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 5, y: 5, button: 'left', clickCount: 1 });
      expect((await command('type', { tabId: tab2, ref: ref2, text: 'x', allowHosts: [lh], allow: full, ownOrigins: own })).error).toContain('using this tab right now');
      await new Promise((r) => setTimeout(r, 3300));
      expect((await command('type', { tabId: tab2, ref: ref2, text: 'ok', allowHosts: [lh], allow: full, ownOrigins: own })).ok).toBe(true);
    } finally {
      fp.close();
    }
    expect((await command('close', { tabId: tab2, allowHosts: [lh], allow: full, ownOrigins: own })).ok).toBe(true);
    expect((await command('close', { tabId: formTab, allowHosts: [lh], allow: full, ownOrigins: own })).ok).toBe(true);
    void tab;
  }, 240_000);
});