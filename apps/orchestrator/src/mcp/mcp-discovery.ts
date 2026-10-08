import { buildAgentEnv } from '@lds/agent-runner';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpToolInfo } from './mcp-annotations';

/** Connect to an MCP server from its registry config and list its tools with annotations. */
export async function discoverTools(config: Record<string, unknown>, timeoutMs = 20_000): Promise<McpToolInfo[]> {
  const client = new Client({ name: 'aigentron-discovery', version: '1.0.0' });
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  const type = str(config.type);
  const headers = config.headers && typeof config.headers === 'object' ? (config.headers as Record<string, string>) : undefined;
  let transport;
  if (type === 'sse' && str(config.url)) {
    transport = new SSEClientTransport(new URL(str(config.url)!), { requestInit: { headers } });
  } else if ((type === 'http' || type === 'streamable-http') && str(config.url)) {
    transport = new StreamableHTTPClientTransport(new URL(str(config.url)!), { requestInit: { headers } });
  } else if (str(config.command)) {
    transport = new StdioClientTransport({
      command: str(config.command)!,
      args: Array.isArray(config.args) ? config.args.map(String) : [],
      // Same minimal allowlist agents get — never the orchestrator's DATABASE_URL/tokens.
      env: { ...buildAgentEnv({} as Parameters<typeof buildAgentEnv>[0], process.env, process.cwd()), ...(config.env && typeof config.env === 'object' ? (config.env as Record<string, string>) : {}) },
      stderr: 'ignore',
    });
  } else {
    throw new Error('config has neither a url (type http/sse) nor a command');
  }
  const timer = new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`no answer within ${Math.round(timeoutMs / 1000)}s`)), timeoutMs).unref?.());
  try {
    await Promise.race([client.connect(transport), timer]);
    const out: McpToolInfo[] = [];
    let cursor: string | undefined;
    do {
      const page = await Promise.race([client.listTools(cursor ? { cursor } : undefined), timer]);
      for (const t of page.tools) out.push({ name: t.name, annotations: t.annotations ?? null });
      cursor = page.nextCursor;
    } while (cursor && out.length < 500);
    return out;
  } finally {
    await client.close().catch(() => undefined);
  }
}
