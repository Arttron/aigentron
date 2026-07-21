import type { AgentModelEnv } from '@lds/shared';
import type { HookWiring } from './types';

/**
 * Allowlist of base env vars the agent process may inherit. We deliberately do
 * NOT pass the orchestrator's full env — that would leak DATABASE_URL, REDIS_URL,
 * GITHUB_TOKEN, ANTHROPIC_* and any host identity (WIF) vars into the agent,
 * which it could read with `printenv`. Only safe runtime/locale/proxy vars pass;
 * the model creds come solely from `modelEnv`.
 */
const ALLOWED_BASE_ENV = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TERM',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TMPDIR',
  'TEMP',
  'TMP',
  'HOSTNAME',
  'PWD',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
] as const;

/**
 * Build the environment for an agent process from a minimal allowlist of safe
 * base vars + exactly the chosen provider's model vars + the hook context. The
 * agent never sees the orchestrator's secrets or host identity.
 */
export function buildAgentEnv(
  modelEnv: AgentModelEnv,
  base: Record<string, string | undefined>,
  workspaceRoot: string,
  hook?: HookWiring,
): Record<string, string> {
  const env: Record<string, string> = {
    // Hide Claude Code's built-in subagents (general-purpose, Explore, Plan, …)
    // so a lead only ever delegates to OUR registered fleet. Ignored by SDK
    // versions that don't support it. No query() option exists for this.
    CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: '1',
  };
  for (const key of ALLOWED_BASE_ENV) {
    const v = base[key];
    if (v !== undefined) env[key] = v;
  }
  for (const [k, v] of Object.entries(modelEnv)) {
    if (v !== undefined) env[k] = v;
  }

  if (hook) {
    env.LDS_TASK_ID = hook.taskId;
    env.LDS_AGENT_SESSION_ID = hook.agentSessionId;
    env.LDS_APPROVALS_URL = hook.approvalsUrl;
    env.LDS_APPROVAL_TIMEOUT_SECONDS = String(hook.approvalTimeoutSeconds);
    env.LDS_WORKSPACE_ROOT = workspaceRoot;
    env.LDS_SHARED_DIST = hook.sharedDistPath;
    env.LDS_HOOK_SECRET = hook.secret;
  }
  return env;
}
