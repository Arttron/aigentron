import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CommandPipelineService } from './command-pipeline.service';

/** The real MCP protocol over HTTP: a client with the run's bearer calls `run_command`; a client without it is turned away. */
describe('commands MCP server over HTTP', () => {
  let http: Server;
  let url: URL;
  let svc: CommandPipelineService;
  let token: string;
  const asked: string[] = [];

  beforeAll(async () => {
    const approvals = { check: async (i: { toolInput: { command: string } }) => (asked.push(i.toolInput.command), i.toolInput.command.includes('rm -rf') ? { allow: false, reason: 'dangerous' } : { allow: true }) };
    svc = new CommandPipelineService(
      { agentMaxLoadPerCpu: 0, agentMinFreeMemMb: 0, agentMaxStealPct: 0, agentNice: 0 } as never,
      { heavySlots: async () => 1, compression: async () => undefined } as never,
      { get: () => approvals } as never,
    );
    const dir = mkdtempSync(join(tmpdir(), 'pipe-mcp-'));
    token = svc.register('task-mcp', { cwd: dir, workspaceRoot: dir }).token;
    http = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        (req as never as { body: unknown }).body = body ? JSON.parse(body) : undefined;
        void svc.handle(req as never, Object.assign(res, { status: (c: number) => ((res.statusCode = c), Object.assign(res, { json: (j: unknown) => res.end(JSON.stringify(j)), set: () => res, send: (t: string) => res.end(t) })) }) as never);
      });
    });
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
    url = new URL(`http://127.0.0.1:${(http.address() as AddressInfo).port}/`);
  });
  afterAll(() => new Promise<void>((r) => http.close(() => r())));

  const connect = async (bearer?: string) => {
    const client = new Client({ name: 't', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: bearer ? { Authorization: `Bearer ${bearer}` } : {} } }));
    return client;
  };

  it('lists run_command and runs a command', async () => {
    const client = await connect(token);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['run_command']);
    const r = (await client.callTool({ name: 'run_command', arguments: { command: 'echo from-the-pipeline; exit 0' } })) as { content: Array<{ text: string }>; isError?: boolean };
    expect(r.isError).toBeFalsy();
    expect(r.content[0]!.text).toContain('finished, exit code 0');
    expect(r.content[0]!.text).toContain('from-the-pipeline');
    await client.close();
  });

  it('returns a refused command as an error the agent can read', async () => {
    const client = await connect(token);
    const r = (await client.callTool({ name: 'run_command', arguments: { command: 'rm -rf /tmp/x && npm run build' } })) as { content: Array<{ text: string }>; isError?: boolean };
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain('dangerous');
    await client.close();
  });

  it('turns away a client with no or a wrong token', async () => {
    await expect(connect()).rejects.toThrow();
    await expect(connect('wrong')).rejects.toThrow();
  });
});
