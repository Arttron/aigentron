import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { McpService } from './mcp.service';

const COMPOSE = 'http://playwright-mcp:8931/sse';
const ADDON = 'http://127.0.0.1:8931/sse';
let dir: string;
let row: { name: string; config: Record<string, unknown> } | null;

const svc = () => {
  const prisma = {
    mcpServer: {
      findUnique: async () => row,
      update: async ({ data }: { data: { config: Record<string, unknown> } }) => {
        row = { ...row!, config: data.config };
        return row;
      },
    },
  };
  return new McpService(prisma as never, { addonsDir: dir } as never) as unknown as { syncPlaywrightAddon: () => Promise<void> };
};
const state = (enabled: boolean, mcp = 'http://127.0.0.1:8931') => writeFile(join(dir, 'playwright', 'state.json'), JSON.stringify({ name: 'playwright', enabled, backend: 'bare', version: '1', endpoints: { mcp } }));

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'addons-'));
  await mkdir(join(dir, 'playwright'));
  row = { name: 'playwright', config: { type: 'sse', url: COMPOSE } };
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('the playwright MCP server follows the Playwright add-on', () => {
  it('enabled add-on: the entry points at it', async () => {
    await state(true);
    await svc().syncPlaywrightAddon();
    expect(row!.config).toEqual({ type: 'sse', url: ADDON });
  });
  it('disabled again: back to the compose address', async () => {
    await state(true);
    await svc().syncPlaywrightAddon();
    await state(false);
    await svc().syncPlaywrightAddon();
    expect(row!.config.url).toBe(COMPOSE);
  });
  it('no add-on at all: nothing changes', async () => {
    await rm(join(dir, 'playwright', 'state.json'), { force: true });
    await svc().syncPlaywrightAddon();
    expect(row!.config.url).toBe(COMPOSE);
  });
  it('a person’s own address is never touched', async () => {
    row = { name: 'playwright', config: { type: 'sse', url: 'https://my.example/sse', note: 'mine' } };
    await state(true);
    await svc().syncPlaywrightAddon();
    expect(row!.config.url).toBe('https://my.example/sse');
  });
  it('a person’s own LOCAL address is not touched either (only the compose and the add-on addresses are ours)', async () => {
    row = { name: 'playwright', config: { type: 'sse', url: 'http://127.0.0.1:9333/sse' } };
    await svc().syncPlaywrightAddon();
    expect(row!.config.url).toBe('http://127.0.0.1:9333/sse');
    await state(true);
    await svc().syncPlaywrightAddon();
    expect(row!.config.url).toBe('http://127.0.0.1:9333/sse');
  });
  it('other settings of the entry (readOnlyTools …) are kept', async () => {
    row = { name: 'playwright', config: { type: 'sse', url: COMPOSE, readOnlyTools: ['*'] } };
    await state(true);
    await svc().syncPlaywrightAddon();
    expect(row!.config).toEqual({ type: 'sse', url: ADDON, readOnlyTools: ['*'] });
  });
  it('a state that is not valid is ignored', async () => {
    await state(true, 'http://example.com:8931');
    await svc().syncPlaywrightAddon();
    expect(row!.config.url).toBe(COMPOSE);
  });
});
