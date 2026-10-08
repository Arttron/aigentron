import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { INTERNAL_MCP_SERVER } from '@lds/shared';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../config/app-config.service';
import { effectiveReadOnly, readOnlyFromAnnotations, stripRegistryKeys, type McpToolInfo } from './mcp-annotations';
import { discoverTools } from './mcp-discovery';

type McpRow = NonNullable<Awaited<ReturnType<PrismaService['mcpServer']['findUnique']>>>;

/**
 * Seeded MCP servers. playwright runs as a compose service; the others are
 * stdio/remote and need the user to fill in credentials/connection (token, DB
 * URL) and, for code-intel (Serena), `uv` available in the runtime.
 */
const DEFAULT_MCP_SERVERS = [
  // SSE transport — the Claude Agent SDK connects to it reliably (the streamable
  // /mcp endpoint did not load tools). Needs playwright-mcp's --allowed-hosts to
  // include the service name (set in docker-compose).
  { name: 'playwright', config: { type: 'sse', url: 'http://playwright-mcp:8931/sse' } },
  {
    name: 'github',
    config: {
      type: 'http',
      url: 'https://api.githubcopilot.com/mcp/',
      // ${GITHUB_TOKEN} is auto-filled from Settings at spawn time.
      // X-MCP-Toolsets: all → exposes every toolset incl. `actions` (CI runs/
      // jobs/logs). X-MCP-Readonly → only read tools, so the agent can inspect
      // CI/PRs/issues but not mutate (writes stay off entirely).
      headers: {
        Authorization: 'Bearer ${GITHUB_TOKEN}',
        'X-MCP-Toolsets': 'all',
        'X-MCP-Readonly': 'true',
      },
    },
  },
  {
    name: 'postgres',
    config: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-postgres', 'postgresql://user:pass@host:5432/db'],
    },
  },
  {
    name: 'code-intel',
    config: {
      // Serena renamed its entrypoints: the MCP server is now
      // `serena start-mcp-server` (the old `serena-mcp-server` script is gone).
      // --project-from-cwd auto-activates the project from the server's cwd
      // (the SDK spawns it in the agent's worktree, which is a git dir), so
      // tools work immediately instead of returning "No active project".
      command: 'uvx',
      args: [
        '--from',
        'git+https://github.com/oraios/serena',
        'serena',
        'start-mcp-server',
        '--context',
        'ide-assistant',
        '--project-from-cwd',
        '--enable-web-dashboard',
        'False',
      ],
    },
  },
];

/** A Claude Agent SDK MCP server config (stdio | http | sse). */
export type McpConfig = Record<string, unknown>;

/**
 * Registry of MCP servers agents can use. Seeded with `playwright` on first use.
 * Agents reference servers by name; the executor resolves them into the SDK's
 * `mcpServers` map at spawn time.
 */
@Injectable()
export class McpService {
  private readonly logger = new Logger(McpService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly appConfig: AppConfigService,
  ) {}

  private async ensureSeeded(): Promise<void> {
    // Idempotent: adds any missing defaults without overwriting user edits.
    // Filtered here (not `createMany({skipDuplicates:true})`) since that
    // option isn't supported on SQLite.
    const existing = await this.prisma.mcpServer.findMany({
      where: { name: { in: [...DEFAULT_MCP_SERVERS.map((s) => s.name), 'research'] } },
      select: { name: true },
    });
    const existingNames = new Set(existing.map((s) => s.name));
    // The built-in research server lives in this very process; its URL depends on the configured API base.
    const researchSeed = {
      name: 'research',
      config: {
        type: 'http',
        url: `${this.appConfig.approvalsApiUrl.replace(/\/$/, '')}/api/research-mcp`,
        // Declared read-only for the approval classifier (all four tools only read official sources).
        readOnlyTools: ['*'],
      },
    };
    const missing = [...DEFAULT_MCP_SERVERS, researchSeed].filter((s) => !existingNames.has(s.name));
    if (!missing.length) return;
    await this.prisma.mcpServer.createMany({ data: missing as Prisma.McpServerCreateManyInput[] });
    this.logger.log(`Seeded ${missing.length} default MCP server(s)`);
  }

  async list(): Promise<McpRow[]> {
    await this.ensureSeeded();
    return this.prisma.mcpServer.findMany({ orderBy: { name: 'asc' } });
  }

  async getRow(name: string): Promise<McpRow> {
    const row = await this.prisma.mcpServer.findUnique({ where: { name } });
    if (!row) throw new NotFoundException(`MCP server not found: ${name}`);
    return row;
  }

  /**
   * Resolve names → { name: config } for the SDK; unknown names are skipped.
   * `secrets` are substituted into the config — e.g. `${GITHUB_TOKEN}` in a
   * header — so tokens live in settings, not in the stored MCP config.
   */
  async resolveMany(
    names: string[],
    secrets: Record<string, string | null> = {},
  ): Promise<Record<string, McpConfig>> {
    if (!names.length) return {};
    const rows = await this.prisma.mcpServer.findMany({ where: { name: { in: names } } });
    const map: Record<string, McpConfig> = {};
    for (const row of rows) {
      // Registry-only keys (classifier hints) are not part of the SDK/Codex server config — never forward them.
      const runtimeConfig = stripRegistryKeys((row.config ?? {}) as Record<string, unknown>);
      map[row.name] = substituteSecrets(runtimeConfig, secrets) as McpConfig;
    }
    const missing = names.filter((n) => !(n in map));
    if (missing.length) this.logger.warn(`Unknown MCP servers ignored: ${missing.join(', ')}`);
    return map;
  }

  /**
   * Operator-declared read-only tools per MCP server (`readOnlyTools` in the server's config JSON:
   * `["*"]` or a list of tool names). Fed to the approval classifier so a trusted read-only server
   * (a search/fetch tool, a docs server…) doesn't need an approval on every call. Cached briefly:
   * it is consulted on every gated-looking tool call.
   */
  async readOnlyMap(): Promise<Record<string, string[]>> {
    const now = Date.now();
    if (this.roCache && now - this.roCache.at < 5000) return this.roCache.map;
    const rows = await this.prisma.mcpServer.findMany({ select: { name: true, config: true } });
    const map: Record<string, string[]> = {};
    for (const r of rows) {
      const ro = effectiveReadOnly(r.config as Record<string, unknown> | null);
      if (ro) map[r.name] = ro;
    }
    this.roCache = { at: now, map };
    return map;
  }
  private roCache?: { at: number; map: Record<string, string[]> };

  /**
   * Ask the server for its tools (with annotations) and remember which ones it declares read-only.
   * They only take effect when the operator set `"trustAnnotations": true` on the server — a server
   * can claim anything about itself, so this is opt-in. New/unannotated tools stay gated.
   */
  async discover(name: string): Promise<{ trusted: boolean; tools: (McpToolInfo & { readOnly: boolean })[] }> {
    const row = await this.getRow(name);
    const config = (row.config ?? {}) as Record<string, unknown>;
    let tools: McpToolInfo[];
    try {
      tools = await discoverTools(stripRegistryKeys(config));
    } catch (err) {
      throw new BadRequestException(`Could not list tools of "${name}": ${(err as Error).message}`);
    }
    const readOnly = readOnlyFromAnnotations(tools);
    await this.prisma.mcpServer.update({
      where: { name },
      data: { config: { ...config, discoveredReadOnly: readOnly } as Prisma.InputJsonValue },
    });
    this.roCache = undefined;
    const ro = new Set(readOnly);
    return { trusted: config.trustAnnotations === true, tools: tools.map((t) => ({ ...t, readOnly: ro.has(t.name) })) };
  }

  async create(name: string, config: McpConfig): Promise<McpRow> {
    if (name === INTERNAL_MCP_SERVER) {
      throw new BadRequestException(`"${INTERNAL_MCP_SERVER}" is reserved for internal tools`);
    }
    return this.prisma.mcpServer.create({ data: { name, config: config as Prisma.InputJsonValue } });
  }

  async update(name: string, config: McpConfig): Promise<McpRow> {
    await this.getRow(name);
    return this.prisma.mcpServer.update({
      where: { name },
      data: { config: config as Prisma.InputJsonValue },
    });
  }

  async remove(name: string): Promise<void> {
    await this.getRow(name);
    await this.prisma.mcpServer.delete({ where: { name } });
  }
}

/** Recursively replace `${KEY}` in string values with the given secrets. */
function substituteSecrets(value: unknown, secrets: Record<string, string | null>): unknown {
  if (typeof value === 'string') {
    let out = value;
    for (const [key, val] of Object.entries(secrets)) {
      out = out.split('${' + key + '}').join(val ?? '');
    }
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => substituteSecrets(v, secrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, substituteSecrets(v, secrets)]),
    );
  }
  return value;
}
