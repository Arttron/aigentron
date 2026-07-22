import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Injectable } from '@nestjs/common';
import { resolveCorsOrigin } from './cors';

/**
 * Typed access to environment configuration. Reads process.env once and exposes
 * validated, typed getters. Fails fast on missing required values.
 */
@Injectable()
export class AppConfigService {
  readonly port: number;
  readonly databaseUrl: string;
  /** Storage driver, by DATABASE_URL scheme: 'sqlite' (file:...) | 'postgres' (else). */
  readonly storageDriver: 'sqlite' | 'postgres';
  readonly redisUrl: string;
  /** CORS allowlist: an explicit origin list, or localhost regexes by default. */
  readonly corsOrigin: boolean | (string | RegExp)[];

  // agent runtime
  readonly workspaceRepoPath: string;
  readonly worktreesRoot: string;
  /**
   * Shared-workspace mode: all tasks work directly in the main repo dir instead
   * of isolated per-task worktrees. Forces serial execution (concurrency 1) so
   * concurrent tasks don't clobber the shared working tree.
   */
  readonly workspaceShared: boolean;
  /** Directory for agent operational files (skills, generated settings) — kept
   *  out of the project so worktrees only ever contain project files. */
  readonly agentDir: string;
  readonly agentMaxTurns: number;
  /** Max times a task may auto-request "continue?" after hitting the step limit
   *  before it's stalled instead — stops a non-converging run grinding forever. */
  readonly maxContinuations: number;
  /** Inject skills as a short read-on-demand index rather than full text. */
  readonly skillsLazy: boolean;
  /** Auto-deny an identical approval (same tool + signature) once it has already
   *  been gated this many times on a task — breaks a repeat-the-same-action loop. */
  readonly approvalRepeatLimit: number;
  readonly agentConcurrency: number;
  /** Hard ceiling on a single agent run; aborts so it can't wedge a slot. */
  readonly agentRunTimeoutMs: number;
  /**
   * Strict completion contract: when true, a run that finishes cleanly but never
   * calls report_task_status is marked `stalled` (rather than proceeding to the
   * verify gate → done). Default false so existing/weaker models aren't stalled.
   */
  readonly requireStatusReport: boolean;

  // approvals
  readonly approvalsApiUrl: string;
  readonly approvalTimeoutSeconds: number;

  // agent hook wiring
  readonly hookScriptPath: string;
  readonly sharedDistPath: string;
  /** Shared secret the PreToolUse hook presents to the approvals API. */
  readonly hookSecret: string;

  /** Queue driver, by REDIS_URL presence: 'bullmq' (full) | 'embedded' (minimal). */
  readonly queueDriver: 'bullmq' | 'embedded';

  /** LiteLLM proxy admin API — base URL + master key (manage cloud routes). */
  readonly litellmBaseUrl: string;
  readonly litellmMasterKey: string;

  /**
   * `minimal`/single-container profile (docs/plan-single-container.md Phase 3):
   * the orchestrator owns a litellm CHILD PROCESS instead of talking to a
   * separately-run litellm's admin API (which requires litellm's own Postgres —
   * ruled out by the Phase 0 spike). Routes are rendered into a static config
   * file (from ManagedLitellmRoute rows) and the process is restarted on change.
   */
  readonly litellmManaged: boolean;
  /** Where the generated config file is written (also passed to the child via --config). */
  readonly litellmManagedConfigPath: string;
  /** Command + args used to spawn the litellm child process (binary on PATH in the single image). */
  readonly litellmManagedCommand: string;
  readonly litellmManagedArgs: string[];

  /**
   * Where the real Ollama actually lives — used for the model picker (its
   * `ollama list`) and as the api_base of ollama LiteLLM routes. Distinct from a
   * provider's baseUrl, which points at the litellm gateway (litellm converts
   * Anthropic↔Ollama; agents only speak Anthropic). Defaults to the docker host.
   */
  readonly ollamaNativeUrl: string;

  /** Public base URL of the dashboard, for deep links (e.g. from channels). */
  readonly dashboardBaseUrl: string;

  /** Per-task image/PDF attachments live here (under the agent dir, readable
   *  by agents as $LDS_ATTACHMENTS_DIR/<taskId>). */
  readonly attachmentsDir: string;

  /** Host the MCP entry point (POST/GET /api/mcp) for external clients. */
  readonly mcpHostEnabled: boolean;
  /** When non-empty, enables DNS-rebinding protection on the MCP endpoint,
   *  restricting the `Origin` header to this allowlist. */
  readonly mcpAllowedOrigins: string[];
  /** When set, the MCP endpoint requires this token (Bearer header or `?key=`).
   *  Strongly recommended once the endpoint is exposed beyond localhost. */
  readonly mcpToken: string;

  /**
   * Gates `infra/setup-wizard.mjs`'s "advanced" mode — a local confirmation
   * speed bump, not a security boundary (v1 has no auth at all; see
   * hookSecret above for the same shared-secret-from-env pattern). Empty =
   * advanced mode refuses to unlock until the operator sets one.
   */
  readonly wizardAdminPassword: string;

  constructor() {
    this.port = parseInt(process.env.ORCHESTRATOR_PORT ?? '3001', 10);
    this.databaseUrl = this.required('DATABASE_URL');
    // Deploy-profile module selection (docs/plan-single-container.md, Phase 2):
    // a `file:` DATABASE_URL picks the embedded SQLite storage driver (minimal/
    // single-container profile); anything else (postgresql://...) is the `full`
    // profile's Postgres driver — unchanged, the regression baseline.
    this.storageDriver = this.databaseUrl.startsWith('file:') ? 'sqlite' : 'postgres';
    // Deploy-profile module selection (docs/plan-single-container.md): a set
    // REDIS_URL picks the BullMQ queue driver; unset picks the embedded
    // in-process poller (no Redis at all — minimal/single-container profile).
    this.queueDriver = process.env.REDIS_URL ? 'bullmq' : 'embedded';
    this.redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
    this.corsOrigin = resolveCorsOrigin();

    this.workspaceRepoPath = process.env.WORKSPACE_REPO_PATH ?? '/workspace/repo';
    this.worktreesRoot = process.env.WORKTREES_ROOT ?? '/workspace/.worktrees';
    this.agentDir = process.env.AGENT_DIR ?? '/workspace/agent';
    this.agentMaxTurns = parseInt(process.env.AGENT_MAX_TURNS ?? '40', 10);
    this.maxContinuations = parseInt(process.env.MAX_CONTINUATIONS ?? '2', 10);
    // Lazy skills: inject a short index (name + description + path) and let the
    // agent read the full skill file on demand, instead of inlining every
    // skill's full text every turn. Big prompt/token saving on cheap models.
    this.skillsLazy = !/^(0|false|no)$/i.test(process.env.SKILLS_LAZY ?? 'true');
    this.approvalRepeatLimit = parseInt(process.env.APPROVAL_REPEAT_LIMIT ?? '3', 10);
    this.workspaceShared = /^(1|true|yes)$/i.test(process.env.WORKSPACE_SHARED ?? '');
    // Shared workspace = one working tree for all tasks → run them serially.
    this.agentConcurrency = this.workspaceShared
      ? 1
      : parseInt(process.env.AGENT_CONCURRENCY ?? '2', 10);
    this.agentRunTimeoutMs = parseInt(process.env.AGENT_RUN_TIMEOUT_MS ?? '600000', 10);
    this.requireStatusReport = /^(1|true|yes)$/i.test(process.env.REQUIRE_STATUS_REPORT ?? '');

    this.approvalsApiUrl = process.env.APPROVALS_API_URL ?? `http://localhost:${this.port}`;
    this.approvalTimeoutSeconds = parseInt(process.env.APPROVAL_TIMEOUT_SECONDS ?? '300', 10);

    this.hookScriptPath = process.env.HOOK_SCRIPT_PATH ?? defaultHookScriptPath();
    this.sharedDistPath = process.env.SHARED_DIST_PATH ?? safeResolveShared();
    // Stable across this process so all spawned agents share it; random if unset.
    this.hookSecret = process.env.LDS_HOOK_SECRET || randomUUID();
    this.litellmBaseUrl = process.env.LITELLM_BASE_URL ?? 'http://litellm:4000';
    this.litellmMasterKey = process.env.LITELLM_MASTER_KEY ?? '';
    this.ollamaNativeUrl = (process.env.OLLAMA_NATIVE_URL ?? 'http://host.docker.internal:11434').replace(/\/$/, '');
    this.litellmManaged = /^(1|true|yes)$/i.test(process.env.LITELLM_MANAGED ?? '');
    this.litellmManagedConfigPath = process.env.LITELLM_MANAGED_CONFIG_PATH ?? '/data/litellm-config.generated.yaml';
    this.litellmManagedCommand = process.env.LITELLM_MANAGED_COMMAND ?? 'litellm';
    this.litellmManagedArgs = (process.env.LITELLM_MANAGED_ARGS ?? '').split(' ').filter(Boolean);
    this.dashboardBaseUrl = (process.env.DASHBOARD_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
    this.attachmentsDir = process.env.ATTACHMENTS_DIR ?? join(this.agentDir, 'attachments');
    this.mcpHostEnabled = !/^(0|false|no)$/i.test(process.env.MCP_HOST_ENABLED ?? 'true');
    this.mcpAllowedOrigins = (process.env.MCP_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    this.mcpToken = process.env.MCP_TOKEN?.trim() ?? '';
    this.wizardAdminPassword = process.env.WIZARD_ADMIN_PASSWORD ?? '';
  }

  private required(key: string): string {
    const value = process.env[key];
    if (!value) {
      throw new Error(`Missing required environment variable: ${key}`);
    }
    return value;
  }
}

/** Best-effort resolution of the compiled @lds/shared entry for the hook. */
function safeResolveShared(): string {
  try {
    return require.resolve('@lds/shared');
  } catch {
    return '';
  }
}

/**
 * Portable default location of the PreToolUse approval hook script, computed
 * relative to this compiled file (apps/orchestrator/dist/config/) instead of
 * a hardcoded Docker-only absolute path. The old default, `/app/infra/hooks/
 * pre-tool-use.mjs`, only ever resolved in the `full` profile's DEV container
 * — that one bind-mounts the whole repo at `/app`, so the path existed there
 * by accident. `minimal`'s Dockerfile never COPYs `infra/hooks/` into the
 * image at all, and bare-metal has no `/app` directory whatsoever (it installs
 * under `/opt/aigentron/...`) — on both, the hook script silently didn't
 * exist, so `node <scriptPath>` failed to spawn, the SDK never got a
 * PreToolUse decision, and EVERY tool call (not just internal control-plane
 * ones like report_task_status) fell through to the SDK's own interactive
 * permission prompt, which nothing answers in a headless run. Resolving
 * relative to `__dirname` instead works unchanged across all three profiles
 * as long as `infra/hooks/` sits at the same repo-root-relative path — true
 * for bare-metal's full checkout, and now also true for `minimal` once its
 * Dockerfile copies that directory in.
 */
function defaultHookScriptPath(): string {
  return join(__dirname, '..', '..', '..', '..', 'infra', 'hooks', 'pre-tool-use.mjs');
}
