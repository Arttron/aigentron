#!/usr/bin/env node
/**
 * PreToolUse approval hook.
 *
 * Runs as `node pre-tool-use.mjs` inside every agent (wired via the generated
 * settings.json). For each tool call it:
 *   1. classifies locally with the SAME @lds/shared classifier the orchestrator
 *      uses — benign calls are allowed instantly, with no network round-trip;
 *   2. for anything dangerous (or if local classification is unavailable), asks
 *      the orchestrator to open an approval and BLOCKS on the human verdict;
 *   3. fails CLOSED — any error, missing wiring, or timeout results in `deny`.
 *
 * Output contract (Claude Code / Agent SDK): always exit 0 with a single
 * PreToolUse `hookSpecificOutput` JSON object on stdout. We never use exit 2.
 *
 * Per-run context arrives via env (set by @lds/agent-runner):
 *   LDS_APPROVALS_URL, LDS_TASK_ID, LDS_AGENT_SESSION_ID,
 *   LDS_APPROVAL_TIMEOUT_SECONDS, LDS_WORKSPACE_ROOT, LDS_SHARED_DIST
 */
import { pathToFileURL } from 'node:url';

const HOOK_EVENT = 'PreToolUse';

/** Emit exactly one decision, flush stdout, then exit. */
let decided = false;
function decide(decision, reason) {
  if (decided) return;
  decided = true;
  const payload = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: HOOK_EVENT,
      permissionDecision: decision, // 'allow' | 'deny'
      permissionDecisionReason: reason,
    },
  });
  process.stdout.write(payload, () => process.exit(0));
}

function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (buf += chunk));
    process.stdin.on('end', () => resolve(buf));
    // Safety net: never hang if stdin is never closed.
    setTimeout(() => resolve(buf), 2000).unref?.();
  });
}

/** Load the shared danger classifier from its compiled (CJS) dist, if present. */
async function loadClassifier(distPath) {
  if (!distPath) return null;
  try {
    const mod = await import(pathToFileURL(distPath).href);
    return mod.classifyToolCall ?? mod.default?.classifyToolCall ?? null;
  } catch {
    return null;
  }
}

async function fetchJson(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const raw = await readStdin();
  let input = {};
  try {
    input = JSON.parse(raw || '{}');
  } catch {
    /* malformed stdin — treated as unknown tool below */
  }

  const toolName = typeof input.tool_name === 'string' ? input.tool_name : '';
  const toolInput =
    input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const workspaceRoot = process.env.LDS_WORKSPACE_ROOT || input.cwd || undefined;

  const approvalsUrl = process.env.LDS_APPROVALS_URL;
  const taskId = process.env.LDS_TASK_ID;
  const agentSessionId = process.env.LDS_AGENT_SESSION_ID || undefined;
  const timeoutSeconds = Number.parseInt(process.env.LDS_APPROVAL_TIMEOUT_SECONDS ?? '300', 10);

  // 1) Local fast-path: allow benign calls with zero network latency.
  const classify = await loadClassifier(process.env.LDS_SHARED_DIST);
  if (classify) {
    let verdict = null;
    try {
      verdict = classify(toolName, toolInput, { workspaceRoot });
    } catch {
      verdict = null; // fall through to the orchestrator on classifier error
    }
    if (verdict && !verdict.dangerous) {
      return decide('allow', 'auto-allowed (benign)');
    }
  }

  // 2) A verdict is needed from the orchestrator. No wiring -> fail closed.
  if (!approvalsUrl || !taskId) {
    return decide(
      'deny',
      'approval gate not configured (LDS_APPROVALS_URL/LDS_TASK_ID missing) — failing closed',
    );
  }
  const base = approvalsUrl.replace(/\/$/, '');
  const hookSecret = process.env.LDS_HOOK_SECRET ?? '';

  // The orchestrator classifies authoritatively and opens an approval.
  let check;
  try {
    check = await fetchJson(
      `${base}/api/approvals/check`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-lds-hook-secret': hookSecret },
        body: JSON.stringify({ taskId, agentSessionId, toolName, toolInput, workspaceRoot }),
      },
      10_000,
    );
  } catch (err) {
    return decide('deny', `approval check failed (${err.message}) — failing closed`);
  }

  if (check.allow) return decide('allow', 'auto-allowed by orchestrator');
  if (!check.approvalId) return decide('deny', check.reason || 'denied by orchestrator');

  // 3) Block on the human verdict. The server fails closed to `timeout`; our
  // client allows a little extra so the server's response wins the race.
  let approval;
  try {
    approval = await fetchJson(
      `${base}/api/approvals/${check.approvalId}/wait?timeoutMs=${timeoutSeconds * 1000}`,
      { method: 'GET', headers: { 'x-lds-hook-secret': hookSecret } },
      (timeoutSeconds + 10) * 1000,
    );
  } catch (err) {
    return decide('deny', `waiting for approval failed (${err.message}) — failing closed`);
  }

  if (approval.status === 'approved') {
    return decide('allow', `approved by ${approval.resolvedBy || 'human'}`);
  }
  if (approval.status === 'timeout') {
    return decide('deny', `approval timed out after ${timeoutSeconds}s — failing closed`);
  }
  return decide(
    'deny',
    `denied${approval.resolvedBy ? ` by ${approval.resolvedBy}` : ''}: ${check.reason || 'blocked'}`,
  );
}

main().catch((err) => {
  // Last resort: never silently allow.
  decide('deny', `approval hook error: ${err?.message ?? err} — failing closed`);
});
