import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HttpAdapterHost } from '@nestjs/core';
import { afterAll, describe, expect, it } from 'vitest';
import type { AccessService } from '../access/access.service';
import type { AuthService } from '../auth/auth.service';
import type { AppConfigService } from '../config/app-config.service';
import type { UsersService } from '../users/users.service';
import { LocalAgentController } from './local-agent.controller';
import { LocalAgentGateway } from './local-agent.gateway';
import type { LocalAgentPackageService } from './local-agent-package.service';
import { LocalBridgeService } from './local-bridge.service';
import { LocalDevicesService } from './local-devices.service';
import { LocalRulesService } from './local-rules.service';
import { LocalBindingsService } from './local-bindings.service';
import { LocalOsMcpService } from './local-os-mcp.service';
import { LocalLlmService } from './local-llm.service';
import { LocalProjectsController } from './local-projects.controller';
import type { ProjectsService } from '../projects/projects.service';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * The real daemon against the real controller + gateway: `login` (device flow, approved over HTTP), `run`, a command and its answer.
 * Needs the Go binary: `LOCAL_AGENT_BIN=/path/to/aigentron pnpm vitest run src/local-agent/local-agent-e2e.test.ts` (skipped without it).
 */
const BIN = process.env.LOCAL_AGENT_BIN;

describe.skipIf(!BIN || !existsSync(BIN))('the Go daemon against this server', () => {
  const children: ChildProcess[] = [];
  let server: Server | undefined;
  let gateway: LocalAgentGateway | undefined;
  afterAll(() => {
    for (const c of children) c.kill();
    gateway?.onApplicationShutdown();
    server?.close();
  });

  it('login → approve → run → online → a command is answered → revoke stops it', async () => {
    const secrets = mkdtempSync(join(tmpdir(), 'lag-secrets-'));
    const home = mkdtempSync(join(tmpdir(), 'lag-home-'));
    const devices = new LocalDevicesService({ secretsDir: secrets, agentDir: secrets } as AppConfigService);
    const bridge = new LocalBridgeService(devices);
    const auth = { isConfigured: () => false, userById: async (id: string) => ({ id, displayName: 'Op', role: 'operator' }) } as unknown as AuthService;
    const users = { defaultOperator: async () => ({ id: 'op' }), list: async () => [] } as unknown as UsersService;
    const rules = new LocalRulesService({ secretsDir: secrets } as AppConfigService, bridge);
    const bindings = new LocalBindingsService({ secretsDir: secrets } as AppConfigService, { project: { findUnique: async ({ where }: { where: { id: string } }) => ({ name: where.id, repoUrl: where.id === 'p1' ? 'https://github.com/acme/shop.git' : where.id === 'p4' ? null : 'https://github.com/acme/other.git', archivedAt: null }) } } as unknown as PrismaService, bridge, devices);
    const ctl = new LocalAgentController(auth, users, devices, bridge, {} as LocalAgentPackageService, rules, bindings);

    const mcp = new LocalOsMcpService(bridge, bindings);
    const projectsCtl = new LocalProjectsController(devices, { list: async () => [{ id: 'p1', slug: 'shop', name: 'Shop', repoUrl: 'https://u:tok@github.com/acme/shop.git' }, { id: 'p3', slug: 'local', name: 'Local', repoUrl: '/srv/git/x' }] } as unknown as ProjectsService);
    const llm = new LocalLlmService({ secretsDir: secrets, approvalsApiUrl: 'http://x' } as AppConfigService, bridge, devices);
    // the controller's routes behind a thin router (the repo's tests do not start Nest)
    const handle = async (req: IncomingMessage, body: unknown): Promise<unknown> => {
      const r = { ip: '127.0.0.1', headers: req.headers, protocol: 'http' } as never;
      const url = req.url ?? '';
      if (req.method === 'POST' && url === '/api/local-agent/device/start') return ctl.start(r, body);
      if (req.method === 'POST' && url === '/api/local-agent/device/poll') return ctl.poll(body);
      if (req.method === 'POST' && url === '/api/local-agent/device/approve') return ctl.approve(r, body as never);
      const del = /^\/api\/local-agent\/devices\/([\w-]+)$/.exec(url);
      if (req.method === 'DELETE' && del) return ctl.remove(r, del[1]!);
      throw Object.assign(new Error(`no route: ${req.method} ${url}`), { getStatus: () => 404 });
    };
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (d) => (raw += d));
      req.on('end', () => {
        // the few express helpers the machine routes use
        const xres = Object.assign(res, {
          status: (c: number) => ((res.statusCode = c), xres),
          json: (b: unknown) => (res.setHeader('content-type', 'application/json'), res.end(JSON.stringify(b)), xres),
          set: (k: string | Record<string, string>, v?: string) => (typeof k === 'string' ? res.setHeader(k, v!) : Object.entries(k).forEach(([a, b]) => res.setHeader(a, b)), xres),
          send: (b: string) => (res.end(b), xres),
        });
        (req as unknown as { body: unknown }).body = raw ? JSON.parse(raw) : undefined;
        if (req.url === '/api/local-agent/projects') {
          void Promise.resolve()
            .then(() => projectsCtl.list(req as never))
            .then((b) => xres.json(b), () => xres.status(401).json({}));
          return;
        }
        if (req.url === '/api/local-os-mcp') {
          void mcp.handle(req as never, xres as never);
          return;
        }
        if (req.url === '/api/local-llm/v1/models') {
          if (!llm.authorized(req.headers.authorization)) return void xres.status(401).json({});
          void llm.modelsResponse().then((b) => xres.json(b));
          return;
        }
        if (req.url === '/api/local-llm/v1/chat/completions') {
          if (!llm.authorized(req.headers.authorization)) return void xres.status(401).json({});
          void llm.chat(req as never, xres as never);
          return;
        }
        handle(req, raw ? JSON.parse(raw) : {}).then(
          (out) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out)),
          (e: { getStatus?: () => number; message: string }) => res.writeHead(e.getStatus?.() ?? 500, { 'content-type': 'application/json' }).end(JSON.stringify({ message: e.message })),
        );
      });
    }).listen(Number(process.env.LIVE_PORT ?? 0), process.env.LIVE_PORT ? '0.0.0.0' : '127.0.0.1');
    await new Promise((r) => server!.once('listening', r));
    gateway = new LocalAgentGateway({ httpAdapter: { getHttpServer: () => server } } as unknown as HttpAdapterHost, bridge, devices, { allowsRequest: () => true } as unknown as AccessService);
    gateway.onApplicationBootstrap();
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const env = { ...process.env, AIGENTRON_LOCAL_HOME: home };
    const serverUrl = base;

    // login: the daemon prints the code; "the person" approves it over HTTP
    const login = spawn(BIN!, ['login', '--server', serverUrl, '--name', 'e2e-box', '--no-browser'], { env });
    children.push(login);
    let out = '';
    login.stdout.on('data', (d) => (out += d));
    const done = new Promise<number | null>((r) => login.on('exit', r));
    const code = await vi_waitFor(() => /([A-Z2-9]{4}-[A-Z2-9]{4})/.exec(out)?.[1]);
    const res = await fetch(`${serverUrl}/api/local-agent/device/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, approve: true }) });
    expect(res.status).toBe(200);
    expect(await done).toBe(0);

    expect(devices.list()).toHaveLength(1);
    const id = devices.list()[0]!.id;

    // run: it connects, says hello, and answers `status`
    const run = spawn(BIN!, ['run'], { env });
    children.push(run);
    await vi_waitFor(() => (bridge.isOnline(id) ? true : undefined));
    expect(bridge.connection(id)).toMatchObject({ host: expect.any(String), os: process.platform, arch: expect.any(String) });
    const r = await bridge.request(id, 'status');
    expect(r).toMatchObject({ ok: true, data: { os: process.platform, roots: 0 } });
    const bad = await bridge.request(id, 'nope');
    expect(bad).toMatchObject({ ok: false, error: expect.stringContaining('unknown op') });

    // the global rules: saved on the server → pushed to the online computer → written to its file, which a project file cannot override upward
    expect(await rules.set({ snapshot: { idleMinutes: 7 }, projectCanEnable: ['fetch'] })).toMatchObject({ ok: true, rev: 1 });
    await vi_waitFor(() => (bridge.connection(id)?.configRev === 1 ? true : undefined));
    const synced = readFileSync(join(home, 'rules.global.yaml'), 'utf8');
    expect(synced).toContain('# revision: 1');
    expect(synced).toContain('idleMinutes: 7');
    expect(await bridge.request(id, 'status')).toMatchObject({ ok: true, data: { configRev: 1 } });
    const repo = mkdtempSync(join(tmpdir(), 'lag-repo-'));
    mkdirSync(join(repo, '.aigentron'));
    writeFileSync(join(repo, '.aigentron', 'local.yaml'), 'snapshot: {enabled: false}\nproposeCommit: {enabled: true}\n');
    const shown = execFileSync(BIN!, ['rules', '--repo', repo], { env, encoding: 'utf8' });
    expect(shown).toContain('"idleMinutes": 7'); // the global value reaches the effective rules
    expect(JSON.parse(shown.slice(shown.indexOf('{'), shown.lastIndexOf('}') + 1))).toMatchObject({ snapshot: { enabled: false }, proposeCommit: { enabled: false } });
    expect(shown).toContain('proposeCommit'); // the refusal is explained
    expect(await rules.set({ quiet: { typingSeconds: 1 } })).toMatchObject({ ok: false }); // an invalid change is refused and nothing is pushed
    expect(rules.get().rev).toBe(1);

    // a computer that reconnects with an older revision is brought up to date
    run.kill();
    await vi_waitFor(() => (bridge.isOnline(id) ? undefined : true));
    expect(await rules.set({ snapshot: { idleMinutes: 9 } })).toMatchObject({ ok: true, rev: 2 });
    const run2 = spawn(BIN!, ['run'], { env: { ...env, AIGENTRON_LOCAL_POLL_SECONDS: '1' } });
    children.push(run2);
    await vi_waitFor(() => (bridge.connection(id)?.configRev === 2 ? true : undefined));
    expect(readFileSync(join(home, 'rules.global.yaml'), 'utf8')).toContain('# revision: 2');

    // L1: a repository the person allowed on their computer is shown, bound to a project, and read by an agent — read only, secrets never
    const proj = mkdtempSync(join(tmpdir(), 'lag-l1-'));
    const sh = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }, encoding: 'utf8' });
    sh(proj, 'init', '-q', '-b', 'main');
    sh(proj, 'remote', 'add', 'origin', 'https://user:ghp_SECRETTOKEN@github.com/acme/shop.git');
    writeFileSync(join(proj, 'README.md'), '# Shop\n');
    writeFileSync(join(proj, '.env'), 'TOKEN=TOPSECRET\n');
    mkdirSync(join(proj, 'src'));
    writeFileSync(join(proj, 'src', 'app.go'), 'package app\n');
    sh(proj, 'add', '-f', '.');
    sh(proj, 'commit', '-qm', 'first commit');
    writeFileSync(join(proj, 'src', 'app.go'), 'package app\n// uncommitted change\n');
    writeFileSync(join(proj, '.env'), 'TOKEN=CHANGED-TOPSECRET\n');
    const fast = { ...env, AIGENTRON_LOCAL_POLL_SECONDS: '1' };
    // nothing is reachable until a repository is added on that computer
    const noRepos = await bridge.request(id, 'repos.list');
    expect(noRepos).toMatchObject({ ok: true, data: { repos: [] } });
    expect(execFileSync(BIN!, ['add', proj], { env: fast, encoding: 'utf8' })).toContain('Allowed');
    expect(() => execFileSync(BIN!, ['add', tmpdir()], { env: fast, stdio: 'pipe' })).toThrow(); // not a git repository
    await vi_waitFor(() => bridge.repos(id).find((r) => r.unstaged === 2 || r.unstaged === 1) ?? undefined, 15_000);
    const reported = bridge.repos(id)[0]!;
    expect(reported).toMatchObject({ branch: 'main', origin: 'https://github.com/acme/shop.git' });
    expect(JSON.stringify(reported)).not.toContain('SECRETTOKEN'); // a token in the remote URL never leaves the machine

    // binding: only to the project whose repository this is
    expect(await bindings.create({ projectId: 'p2', deviceId: id, repoId: reported.id }, 'op')).toMatchObject({ ok: false, error: expect.stringContaining('not the project') });
    const bound = await bindings.create({ projectId: 'p1', deviceId: id, repoId: reported.id }, 'op');
    expect(bound.ok).toBe(true);
    expect(await mcp.availableFor('p1')).toBe(true);
    expect(await mcp.availableFor('p2')).toBe(false);
    // a project WITHOUT a repository address has nothing to compare: the person's Share is the consent (the folder's name does not matter)
    const free = await bindings.create({ projectId: 'p4', deviceId: id, repoId: reported.id }, 'op');
    expect(free.ok).toBe(true);
    expect(await mcp.availableFor('p4')).toBe(true);
    if (free.ok) bindings.remove(free.binding.id);
    expect(await mcp.availableFor('p4')).toBe(false);

    // an agent's run: the MCP server over HTTP, with the run's own bearer
    const mcpUrl = new URL(`${base}/api/local-os-mcp`);
    const connect = async (project: string) => {
      const c = new Client({ name: 'test', version: '1' });
      await c.connect(new StreamableHTTPClientTransport(mcpUrl, { requestInit: { headers: { Authorization: `Bearer ${mcp.register('t1', project).token}` } } }));
      return c;
    };
    const call = async (c: Client, name: string, args: Record<string, unknown> = {}) => {
      const r = (await c.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text: string }[] };
      return { error: r.isError === true, text: r.content.map((x) => x.text).join('\n') };
    };
    const agent = await connect('p1');
    const tools = (await agent.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(['local_diff', 'local_log', 'local_read', 'local_repos', 'local_status']); // read only: no tool changes anything
    expect((await call(agent, 'local_repos')).text).toContain(reported.id);
    const status = await call(agent, 'local_status');
    expect(status.text).toContain('branch main');
    expect(status.text).toContain('src/app.go');
    expect(status.text).toContain('untrusted');
    const diff = await call(agent, 'local_diff');
    expect(diff.text).toContain('// uncommitted change');
    expect(diff.text).not.toContain('TOPSECRET'); // the changed .env is not in the diff
    expect((await call(agent, 'local_log')).text).toContain('first commit');
    expect((await call(agent, 'local_read', { path: 'README.md' })).text).toContain('# Shop');
    for (const bad of ['.env', '../../etc/passwd', '.git/config', '/etc/passwd']) {
      const r = await call(agent, 'local_read', { path: bad });
      expect(r.error, bad).toBe(true);
      expect(r.text).not.toContain('TOPSECRET');
    }
    // another project's agent has no repository at all; a run without a valid token gets nothing
    const stranger = await connect('p2');
    expect((await call(stranger, 'local_status')).error).toBe(true);
    expect((await fetch(mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(401);
    // the computer takes the repository back: the tools stop working at once
    expect(execFileSync(BIN!, ['remove', reported.id], { env: fast, encoding: 'utf8' })).toContain('Removed');
    await vi_waitFor(() => (bridge.repos(id).length === 0 ? true : undefined), 15_000);
    expect((await call(agent, 'local_status')).error).toBe(true);
    expect(await mcp.availableFor('p1')).toBe(false);
    await agent.close();
    await stranger.close();

    // the server lives in this process: a command that talks to it must not block the event loop (execFileSync would)
    const runAsync = (args: string[]) =>
      new Promise<{ code: number; stdout: string }>((resolve) => {
        execFile(BIN!, args, { env: fast, encoding: 'utf8' }, (err, stdout) => resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout }));
      });
    // open: the program asks the server for projects (with its own token), and recognises a copy that is already here
    expect((await fetch(`${base}/api/local-agent/projects`)).status).toBe(401);
    const listed = (await runAsync(['open'])).stdout;
    expect(listed).toContain('shop');
    expect(listed).toContain('https://github.com/acme/shop.git'); // the password in the stored address never reaches the computer
    expect(listed).not.toContain('tok@');
    expect(listed).not.toContain('/srv/git'); // a local path is not offered
    const here = mkdtempSync(join(tmpdir(), 'lag-open-'));
    sh(here, 'init', '-q', '-b', 'main');
    sh(here, 'remote', 'add', 'origin', 'git@github.com:Acme/Shop.git'); // another spelling of the same repository
    expect((await runAsync(['open', 'shop', '--dir', here, '--yes'])).stdout).toContain('Allowed:');
    await vi_waitFor(() => (bridge.repos(id).length === 1 ? true : undefined), 15_000);
    const other = mkdtempSync(join(tmpdir(), 'lag-open-'));
    sh(other, 'init', '-q', '-b', 'main');
    sh(other, 'remote', 'add', 'origin', 'https://github.com/someone/else.git');
    writeFileSync(join(other, 'f'), 'x');
    expect((await runAsync(['open', 'shop', '--dir', other, '--yes'])).code).not.toBe(0); // not this project's repository
    expect((await runAsync(['open', 'nope'])).code).not.toBe(0);
    execFileSync(BIN!, ['remove', here], { env: fast });

    // a model on the person's computer, shared with the server: a fake OpenAI-style server stands in for Ollama / LM Studio
    const seen: { stream?: unknown; model?: unknown }[] = [];
    const backend = createServer((rq, rs) => {
      let b = '';
      rq.on('data', (d) => (b += d));
      rq.on('end', () => {
        if (rq.url === '/v1/models') return void rs.end(JSON.stringify({ data: [{ id: 'qwen3-coder:30b' }, { id: 'private-model' }] }));
        const body = JSON.parse(b) as { stream?: unknown; model?: unknown };
        seen.push(body);
        rs.writeHead(200, { 'content-type': 'text/event-stream' });
        const send = (d: object) => rs.write(`data: ${JSON.stringify(d)}\n\n`);
        send({ id: 'c1', created: 1, choices: [{ index: 0, delta: { role: 'assistant', content: 'Hel' } }] });
        send({ id: 'c1', choices: [{ index: 0, delta: { content: 'lo' } }] });
        send({ id: 'c1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        rs.end('data: [DONE]\n\n');
      });
    }).listen(0, '127.0.0.1');
    await new Promise((r) => backend.once('listening', r));
    children.push({ kill: () => backend.close() } as unknown as ChildProcess);
    const llmUrl = `http://127.0.0.1:${(backend.address() as { port: number }).port}`;
    const llmBase = `${base}/api/local-llm/v1`;
    const bearer = { authorization: `Bearer ${llm.key()}`, 'content-type': 'application/json' };
    // nothing is shared until the person says so on that computer
    llm['cache'].clear();
    expect(await (await fetch(`${llmBase}/models`, { headers: bearer })).json()).toMatchObject({ data: [] });
    expect((await fetch(`${llmBase}/models`, { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
    expect(execFileSync(BIN!, ['llm', 'add', 'ollama', process.env.LIVE_LLM_URL ?? llmUrl], { env: fast, encoding: 'utf8' })).toContain('Nothing is shared yet');
    expect(() => execFileSync(BIN!, ['llm', 'add', 'x', 'http://example.com:11434'], { env: fast, stdio: 'pipe' })).toThrow(); // not this computer
    execFileSync(BIN!, ['llm', 'allow', 'qwen*'], { env: fast });
    llm['cache'].clear();
    // manual live check (not in CI): keep this server up with the REAL model so LiteLLM / an agent can be pointed at it, then stop
    if (process.env.LIVE_HOLD_SECONDS) {
      execFileSync(BIN!, ['llm', 'allow', 'qwen3-coder*'], { env: fast });
      llm['cache'].clear();
      console.log(`LIVE base=${llmBase} key=${llm.key()}`);
      writeFileSync('/tmp/live.key', llm.key());
      await new Promise((r) => setTimeout(r, Number(process.env.LIVE_HOLD_SECONDS) * 1000));
      return;
    }
    expect(await (await fetch(`${llmBase}/models`, { headers: bearer })).json()).toMatchObject({ data: [{ id: 'qwen3-coder:30b' }] }); // private-model stays hidden
    // streaming, as LiteLLM asks for it
    const streamed = await (await fetch(`${llmBase}/chat/completions`, { method: 'POST', headers: bearer, body: JSON.stringify({ model: 'qwen3-coder:30b', stream: true, messages: [{ role: 'user', content: 'hi' }] }) })).text();
    expect(streamed).toContain('"content":"Hel"');
    expect(streamed.trim().endsWith('data: [DONE]')).toBe(true);
    // not streaming: the chunks come back folded into one completion (and the backend was still asked to stream)
    const whole = (await (await fetch(`${llmBase}/chat/completions`, { method: 'POST', headers: bearer, body: JSON.stringify({ model: 'qwen3-coder:30b', messages: [] }) })).json()) as { choices: { message: { content: string }; finish_reason: string }[] };
    expect(whole.choices[0]).toMatchObject({ message: { content: 'Hello' }, finish_reason: 'stop' });
    expect(seen.every((x) => x.stream === true)).toBe(true);
    // a model the person did not share is refused (by the server's list, and by the computer if asked anyway)
    expect((await fetch(`${llmBase}/chat/completions`, { method: 'POST', headers: bearer, body: JSON.stringify({ model: 'private-model', messages: [] }) })).status).toBe(503); // "unavailable": the agent's next provider takes over
    const refused = await (await fetch(`${llmBase}/chat/completions`, { method: 'POST', headers: bearer, body: JSON.stringify({ model: 'private-model', messages: [] }) })).json() as { error: { message: string } };
    expect(refused.error.message).toMatch(/Service unavailable/);
    const direct = await bridge.request(id, 'llm.chat', { id: 'x', request: { model: 'private-model', messages: [] } });
    expect(direct).toMatchObject({ ok: false, error: expect.stringContaining('not shared') });
    expect(seen.some((x) => x.model === 'private-model')).toBe(false);

    // revoking tells the daemon, which stops (a revoked agent does not retry)
    const exited = new Promise<number | null>((resolve) => run2.on('exit', resolve));
    const del = await fetch(`${serverUrl}/api/local-agent/devices/${id}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect(await exited).toBe(1);
  }, 60_000 + Number(process.env.LIVE_HOLD_SECONDS ?? 0) * 1000);
});

async function vi_waitFor<T>(fn: () => T | undefined, ms = 15_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 50));
  }
}
