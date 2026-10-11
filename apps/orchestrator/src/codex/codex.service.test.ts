import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CodexService, parseCodexModels } from './codex.service';

describe('parseCodexModels', () => {
  it('keeps the visible models, best (lowest priority number) first', () => {
    const json = {
      models: [
        { slug: 'gpt-5.6-luna', visibility: 'list', priority: 9 },
        { slug: 'gpt-6.1-sol', visibility: 'list', priority: 1 },
        { slug: 'gpt-reserve', visibility: 'hide', priority: 4 },
        { slug: 'gpt-6-astra', visibility: 'list', priority: 2 },
      ],
    };
    expect(parseCodexModels(json)).toEqual(['gpt-6.1-sol', 'gpt-6-astra', 'gpt-5.6-luna']);
  });
  it('is empty for anything unexpected', () => {
    expect(parseCodexModels(null)).toEqual([]);
    expect(parseCodexModels({})).toEqual([]);
    expect(parseCodexModels({ models: 'x' })).toEqual([]);
    expect(parseCodexModels({ models: [{ visibility: 'list' }] })).toEqual([]);
  });
});

describe('CodexService before anyone has signed in', () => {
  it('creates the sign-in folder first (Codex fails on a missing CODEX_HOME) and reports "not signed in" without the CLI noise', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codexsvc-'));
    const bin = join(dir, 'codex');
    // a stand-in CLI that behaves like the real one: it errors when CODEX_HOME does not exist
    writeFileSync(bin, '#!/bin/sh\nif [ ! -d "$CODEX_HOME" ]; then echo "WARNING: proceeding, even though we could not create PATH aliases" >&2; echo "Error loading configuration: CODEX_HOME points to $CODEX_HOME, but that path does not exist" >&2; exit 1; fi\necho "Not logged in"\nexit 1\n');
    chmodSync(bin, 0o755);
    process.env.CODEX_BIN = bin;
    const secrets = join(dir, 'secrets');
    const svc = new CodexService({ secretsDir: secrets, agentDir: join(dir, 'agent') } as never);
    const st = await svc.status();
    expect(existsSync(join(secrets, 'codex'))).toBe(true);
    expect(st).toMatchObject({ installed: true, loggedIn: false });
    expect(st.message).toMatch(/Not logged in/);
    expect(st.message).not.toMatch(/WARNING: proceeding/);
    delete process.env.CODEX_BIN;
  });
});
