#!/usr/bin/env node
/**
 * Dependency-injection smoke test of the COMPILED app: every provider of every module must be resolvable.
 * (vitest/esbuild does not emit decorator metadata, so this cannot be a unit test — it runs against dist/, which tsc builds with it.)
 * Usage: pnpm --filter @lds/orchestrator build && node apps/orchestrator/scripts/di-graph.cjs
 * A missing module import otherwise only fails at start-up (it once stopped the server from booting).
 */
require('reflect-metadata');
const { mkdtempSync, rmSync, existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const dist = join(process.env.DI_DIST ? process.env.DI_DIST : join(__dirname, '..', 'dist'), 'app.module.js');
if (!existsSync(dist)) {
  console.error('di-graph: dist/app.module.js not found — build first (pnpm --filter @lds/orchestrator build)');
  process.exit(2);
}
const dir = mkdtempSync(join(tmpdir(), 'lds-graph-'));
Object.assign(process.env, {
  DATABASE_URL: `file:${join(dir, 'graph.db')}`,
  AGENT_DIR: join(dir, 'agent'),
  SECRETS_DIR: join(dir, 'secrets'),
  WORKSPACE_REPO_PATH: join(dir, 'repo'),
  WORKTREES_ROOT: join(dir, 'worktrees'),
  WORKSPACE_DIR: join(dir, 'workspace'),
  ATTACHMENTS_DIR: join(dir, 'attachments'),
});
delete process.env.REDIS_URL;

(async () => {
  const { Test } = require('@nestjs/testing');
  const { AppModule } = require(dist);
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  await moduleRef.close().catch(() => undefined);
  console.log('di-graph: OK — all providers resolve');
})()
  .catch((e) => {
    console.error('di-graph: FAILED —', e && e.message ? e.message.split('\n')[0] : e);
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(dir, { recursive: true, force: true });
    // providers may leave timers / connections open: the check is done, do not wait for them
    process.exit(process.exitCode ?? 0);
  });
setTimeout(() => {
  console.error('di-graph: FAILED — timed out after 90 s (a provider constructor hangs?)');
  process.exit(3);
}, 90_000).unref();
