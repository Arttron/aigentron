const PROVIDER_KINDS = ['anthropic', 'openai', 'deepseek', 'ollama', 'codex'];
const PROVIDER_AUTH_MODES = {
  codex: ['codex-login', 'api-key'],
  other: ['api-key', 'auth-token', 'oauth-token'],
};
export interface ProviderProposal {
  name: string;
  kind: string;
  model: string;
  authMode: string;
  baseUrl?: string;
  makeDefault?: boolean;
  reason: string;
}

/** Why a provider proposal is malformed (null = fine). Note there is deliberately no secret field. */
export function validateProviderProposal(p: Partial<ProviderProposal>): string | null {
  const name = (p.name ?? '').trim();
  if (!/^[\w-]{1,60}$/.test(name)) return 'provider name must be letters, digits, dash or underscore (max 60).';
  if (!p.kind || !PROVIDER_KINDS.includes(p.kind)) return `kind must be one of: ${PROVIDER_KINDS.join(', ')}.`;
  const allowed = p.kind === 'codex' ? PROVIDER_AUTH_MODES.codex : PROVIDER_AUTH_MODES.other;
  if (!p.authMode || !allowed.includes(p.authMode)) return `for kind ${p.kind}, authMode must be one of: ${allowed.join(', ')}.`;
  if (!p.model || !p.model.trim() || p.model.length > 120) return 'give a model name (max 120 characters).';
  if (p.baseUrl) {
    try {
      const u = new URL(p.baseUrl);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'baseUrl must be an http(s) URL.';
      if (u.username || u.password) return 'baseUrl must not contain credentials — keys are entered in Settings, never in a URL.';
    } catch {
      return 'baseUrl is not a valid URL.';
    }
  }
  if (p.kind === 'codex' && p.baseUrl) return 'a codex provider has no base URL.';
  return null;
}

/** Settings the admin may change (no secrets, no repo URL, no providers/channels/users). */
const SETTINGS_KEYS = ['defaultAgent', 'verifyCommands', 'verifyMaxAttempts', 'concurrency', 'approvalTimeoutSeconds', 'agentInstructions', 'repoBranch', 'workspaceSubdir'] as const;
const SUBDIR_RE = /^(?!\/)(?!.*(:|@|\\|(^|\/)\.\.(\/|$)))[^\s]*$/;

/** Why a settings proposal is malformed (null = fine). Agent existence is checked separately (async). */
export function validateSettingsChanges(ch: Record<string, unknown> | undefined): string | null {
  if (!ch || typeof ch !== 'object' || !Object.keys(ch).length) return 'give at least one setting to change.';
  const unknown = Object.keys(ch).filter((k) => !(SETTINGS_KEYS as readonly string[]).includes(k));
  if (unknown.length) return `these settings can't be changed by the admin: ${unknown.join(', ')}. Allowed: ${SETTINGS_KEYS.join(', ')}.`;
  const int = (k: string, lo: number, hi: number) => {
    const v = ch[k];
    return v === undefined || (typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi) ? null : `${k} must be an integer between ${lo} and ${hi}.`;
  };
  const err = int('verifyMaxAttempts', 0, 10) ?? int('concurrency', 1, 16) ?? int('approvalTimeoutSeconds', 30, 3600);
  if (err) return err;
  if (ch.defaultAgent !== undefined && (typeof ch.defaultAgent !== 'string' || !/^[\w-]{1,60}$/.test(ch.defaultAgent))) return 'defaultAgent must be an agent name.';
  if (ch.verifyCommands !== undefined && (typeof ch.verifyCommands !== 'string' || ch.verifyCommands.length > 2000)) return 'verifyCommands must be text up to 2000 characters.';
  if (ch.agentInstructions !== undefined && (typeof ch.agentInstructions !== 'string' || !ch.agentInstructions.trim() || ch.agentInstructions.length > 4000)) return 'agentInstructions must be non-empty text up to 4000 characters.';
  if (ch.repoBranch !== undefined && (typeof ch.repoBranch !== 'string' || !/^[\w./-]{1,100}$/.test(ch.repoBranch) || ch.repoBranch.includes('..'))) return 'repoBranch must be a plain branch name.';
  if (ch.workspaceSubdir !== undefined && (typeof ch.workspaceSubdir !== 'string' || ch.workspaceSubdir.length > 300 || !SUBDIR_RE.test(ch.workspaceSubdir))) return 'workspaceSubdir must be a relative folder inside the repo (e.g. apps/web), not a URL or absolute path.';
  return null;
}
