import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';

/** How long to wait for the freshly-spawned litellm to answer before giving up. */
// Generous: the first start of `litellm[proxy]` on a small VM can take over a minute (heavy imports).
const READY_TIMEOUT_MS = 120_000;
/** How many recent output lines of the child to keep for the failure message. */
const TAIL_LINES = 30;
const READY_POLL_MS = 500;

/**
 * The `minimal`/single-container profile's litellm driver (docs/plan-single-
 * container.md Phase 3, resolved by the Phase 0 spike: litellm's admin API
 * hard-requires ITS OWN Postgres, so a Redis-less/Postgres-less deployment
 * can't use it). Instead of calling `/model/new` on a separately-run litellm,
 * this service OWNS a litellm child process: routes persist in the
 * `ManagedLitellmRoute` table (the equivalent of litellm's own DB), rendered
 * into a static `--config` file, and the process is restarted whenever a
 * route changes (~9s measured in the spike — a rare admin action, not a hot
 * path). `LitellmService` delegates its 3 mutating methods here when
 * `config.litellmManaged` is set; its read methods (`/model/info`) work
 * identically against a managed litellm (also verified in the Phase 0/3
 * spikes — that endpoint is DB-independent), so they need no branch.
 */
@Injectable()
export class LitellmManagedService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LitellmManagedService.name);
  private child?: ChildProcess;
  private tail: string[] = [];
  /** Serializes regenerate+restart calls so concurrent route CRUD can't race two restarts. */
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.config.litellmManaged) return;
    await this.regenerateAndRestart();
  }

  onModuleDestroy(): void {
    this.child?.kill();
  }

  async registerRoute(
    name: string,
    backend: string,
    params: { apiBase: string | null; apiKey: string; rpm?: number | null; tpm?: number | null; dropReasoning: boolean },
  ): Promise<void> {
    await this.prisma.managedLitellmRoute.upsert({
      where: { name },
      create: { name, backend, apiBase: params.apiBase, apiKey: params.apiKey || null, rpm: params.rpm, tpm: params.tpm, dropReasoning: params.dropReasoning },
      update: { backend, apiBase: params.apiBase, apiKey: params.apiKey || null, rpm: params.rpm, tpm: params.tpm, dropReasoning: params.dropReasoning },
    });
    await this.regenerateAndRestart();
  }

  async ensureRoute(
    name: string,
    backend: string,
    params: { apiBase: string | null; apiKey: string; rpm?: number | null; tpm?: number | null; dropReasoning: boolean },
  ): Promise<void> {
    const exists = await this.prisma.managedLitellmRoute.findUnique({ where: { name }, select: { id: true } });
    if (!exists) await this.registerRoute(name, backend, params);
  }

  async deleteRoutesFor(namePrefix: string): Promise<void> {
    const deleted = await this.prisma.managedLitellmRoute.deleteMany({ where: { name: { startsWith: namePrefix } } });
    if (deleted.count) await this.regenerateAndRestart();
  }

  /** Serialized entry point: queue this regenerate+restart behind any in-flight one. */
  private regenerateAndRestart(): Promise<void> {
    this.queue = this.queue.then(
      () => this.doRegenerateAndRestart(),
      () => this.doRegenerateAndRestart(), // a prior failure must not wedge the queue
    );
    return this.queue;
  }

  private async doRegenerateAndRestart(): Promise<void> {
    const routes = await this.prisma.managedLitellmRoute.findMany({ orderBy: { name: 'asc' } });
    const yaml = renderLitellmConfig(routes);
    await mkdir(dirname(this.config.litellmManagedConfigPath), { recursive: true });
    await writeFile(this.config.litellmManagedConfigPath, yaml);
    await this.restartChild();
  }

  private async restartChild(): Promise<void> {
    await this.stopChild();
    const port = portOf(this.config.litellmBaseUrl);
    // Bind to loopback by default: only the orchestrator and the agents on this machine talk to it, and litellm's own default
    // (0.0.0.0) would expose the gateway on every network interface of a bare-metal server.
    const args = [...this.config.litellmManagedArgs, '--config', this.config.litellmManagedConfigPath, '--host', this.config.litellmManagedHost, '--port', String(port)];
    this.logger.log(`Starting litellm: ${this.config.litellmManagedCommand} ${args.join(' ')}`);
    // NOT a blanket ...process.env spread: litellm auto-detects ANY DATABASE_URL
    // in its environment for its own (optional, unwanted here) Postgres-backed
    // features and hard-errors on a non-postgres scheme — inheriting the
    // orchestrator's sqlite DATABASE_URL broke boot entirely. Pass through only
    // what a child process needs (PATH et al.), explicitly excluding it.
    const { DATABASE_URL: _DATABASE_URL, ...inheritedEnv } = process.env;
    const child = spawn(this.config.litellmManagedCommand, args, {
      env: { ...inheritedEnv, LITELLM_MASTER_KEY: this.config.litellmMasterKey },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.tail = [];
    const onOutput = (d: Buffer) => {
      const text = d.toString().trimEnd();
      this.logger.debug(`[litellm] ${text}`);
      this.tail.push(...text.split('\n').filter((l) => l.trim()));
      if (this.tail.length > TAIL_LINES) this.tail.splice(0, this.tail.length - TAIL_LINES);
    };
    child.stdout?.on('data', onOutput);
    child.stderr?.on('data', onOutput);
    child.on('error', (e) => this.logger.warn(`could not start litellm (${this.config.litellmManagedCommand}): ${e.message}`));
    child.on('exit', (code, signal) => {
      if (this.child === child) this.child = undefined;
      if (code !== null && code !== 0) this.logger.warn(`litellm exited with code ${code} (signal ${signal ?? 'none'}). Last output:\n${this.tail.join('\n')}`);
    });
    this.child = child;
    await this.waitUntilReady(port, child);
  }

  private async stopChild(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = undefined;
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      child.kill();
      setTimeout(resolve, 5_000); // don't hang the queue forever on a stuck process
    });
  }

  private async waitUntilReady(port: number, child: ChildProcess): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) return; // it died — already reported with its last output
      try {
        const res = await fetch(`http://127.0.0.1:${port}/v1/models`, {
          headers: { authorization: `Bearer ${this.config.litellmMasterKey}` },
        });
        if (res.ok) {
          this.logger.log(`litellm ready on :${port}`);
          return;
        }
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, READY_POLL_MS));
    }
    this.logger.warn(`litellm did not become ready within ${READY_TIMEOUT_MS / 1000}s. Last output:\n${this.tail.join('\n')}`);
  }
}

/** Extract the port from a base URL, defaulting to 4000 (mirrors the full profile's default). */
function portOf(baseUrl: string): number {
  try {
    return Number(new URL(baseUrl).port) || 4000;
  } catch {
    return 4000;
  }
}

/** Always-double-quoted YAML scalar — valid regardless of content, no general emitter needed. */
function yamlStr(v: string): string {
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

interface RouteRow {
  name: string;
  backend: string;
  apiBase: string | null;
  apiKey: string | null;
  rpm: number | null;
  tpm: number | null;
  dropReasoning: boolean;
}

/**
 * Render the full litellm --config file: static `litellm_settings`/
 * `router_settings` (mirroring infra/litellm-config.yaml, the full profile's
 * equivalent) plus one `model_list` entry per managed route. An empty
 * model_list is valid — litellm boots fine with zero models configured.
 */
function renderLitellmConfig(routes: RouteRow[]): string {
  const modelList = routes
    .map((r) => {
      const lines = [
        `  - model_name: ${yamlStr(r.name)}`,
        '    litellm_params:',
        `      model: ${yamlStr(r.backend)}`,
      ];
      if (r.apiBase) lines.push(`      api_base: ${yamlStr(r.apiBase)}`);
      if (r.apiKey) lines.push(`      api_key: ${yamlStr(r.apiKey)}`);
      if (r.rpm) lines.push(`      rpm: ${r.rpm}`);
      if (r.tpm) lines.push(`      tpm: ${r.tpm}`);
      if (r.dropReasoning) {
        lines.push('      drop_params: true');
        lines.push('      additional_drop_params: ["reasoning_effort", "reasoning", "thinking"]');
      }
      return lines.join('\n');
    })
    .join('\n');

  return (
    '# GENERATED by LitellmManagedService — do not hand-edit, changes are overwritten\n' +
    '# on the next route change. Source of truth is the ManagedLitellmRoute table.\n' +
    `model_list:\n${modelList}\n` +
    '\n' +
    'litellm_settings:\n' +
    '  drop_params: true\n' +
    '  request_timeout: 600\n' +
    '  num_retries: 3\n' +
    '\n' +
    'router_settings:\n' +
    '  cooldown_time: 30\n' +
    '  retry_policy:\n' +
    '    RateLimitErrorRetries: 3\n' +
    '    TimeoutErrorRetries: 2\n'
  );
}
