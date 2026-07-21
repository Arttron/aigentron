import { join } from 'node:path';
import { z } from 'zod';
import {
  INTERNAL_MCP_SERVER,
  REPORT_STATUS_TOOL,
  HEARTBEAT_TOOL,
  CREATE_SUBTASK_TOOL,
  CHECK_SUBTASKS_TOOL,
  SCHEDULE_CHECK_TOOL,
  PREVIEW_TOOL,
  PROPOSE_LEARNED_SKILL_TOOL,
} from '@lds/shared';
import { buildAgentEnv } from './env';
import { writeAgentSettings } from './settings';
import { emptyUsage } from './usage';
import type {
  AgentEvent,
  AgentEventHandler,
  AgentRunResult,
  ReportedStatus,
  RunAgentParams,
} from './types';

/**
 * Minimal local typings for the bits of the Claude Agent SDK we use. We load the
 * SDK at runtime via a dynamic import (it is ESM-only), so we deliberately do
 * NOT statically depend on its types — keeping this CommonJS package decoupled
 * from the SDK's module format and `exports`-only resolution.
 */
interface SdkContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: unknown;
  is_error?: boolean;
}
type SdkMessage = {
  type: string;
  subtype?: string;
  session_id?: string;
  model?: string;
  is_error?: boolean;
  result?: string;
  num_turns?: number;
  total_cost_usd?: number;
  duration_api_ms?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  };
  mcp_servers?: { name: string; status?: string }[];
  message?: { content?: SdkContentBlock[] | string };
};
interface SdkQueryOptions {
  cwd?: string;
  env?: Record<string, string>;
  maxTurns?: number;
  resume?: string;
  systemPrompt?: string | { type: 'preset'; preset: 'claude_code'; append?: string };
  allowedTools?: string[];
  disallowedTools?: string[];
  // May hold plain MCP config objects and/or in-process SDK server instances.
  mcpServers?: Record<string, unknown>;
  agents?: Record<string, { description: string; prompt: string; model?: string; tools?: string[] }>;
  settings?: string;
  settingSources?: string[];
  permissionMode?: string;
  abortController?: AbortController;
  stderr?: (data: string) => void;
}
type QueryFn = (params: {
  prompt: string;
  options?: SdkQueryOptions;
}) => AsyncIterable<SdkMessage>;

/** Minimal typings for the SDK's in-process MCP tool helpers. */
type ToolResult = { content: { type: 'text'; text: string }[] };
type ToolFn = (
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
  handler: (args: Record<string, unknown>) => Promise<ToolResult>,
) => unknown;
type CreateSdkMcpServerFn = (opts: { name: string; version?: string; tools?: unknown[] }) => unknown;
type SdkModule = { query: QueryFn; tool: ToolFn; createSdkMcpServer: CreateSdkMcpServerFn };

// Bypass TS' CommonJS downleveling of import() so we truly load the ESM SDK.
const esmImport = new Function('s', 'return import(s)') as (s: string) => Promise<SdkModule>;

/**
 * Build an in-process MCP server exposing `report_task_status` (+ `heartbeat`),
 * whose handlers call the caller's callbacks. Returns null when neither callback
 * is wired. Tools appear to the agent as `mcp__lds__report_task_status` etc.
 */
function buildStatusServer(
  params: RunAgentParams,
  tool: ToolFn,
  createSdkMcpServer: CreateSdkMcpServerFn,
): unknown | null {
  if (
    !params.onReportStatus &&
    !params.onHeartbeat &&
    !params.onCreateSubtask &&
    !params.onCheckSubtasks &&
    !params.onScheduleCheck &&
    !params.onStartPreview &&
    !params.onProposeLearnedSkill
  ) {
    return null;
  }
  const tools: unknown[] = [];

  if (params.onReportStatus) {
    tools.push(
      tool(
        'report_task_status',
        "Report the final outcome of this task. Call this exactly once, at the very end: status 'done' when the work is complete, 'blocked' when you need a human to proceed (put what you need in `handoff`), or 'failed' when you could not do it. This is the authoritative signal that ends the task.",
        {
          status: z.enum(['done', 'failed', 'blocked']),
          summary: z.string().optional(),
          files: z.array(z.string()).optional(),
          handoff: z.string().optional(),
        },
        async (args): Promise<ToolResult> => {
          const report = args as unknown as ReportedStatus;
          params.onReportStatus?.(report);
          return { content: [{ type: 'text', text: `Recorded task status: ${report.status}.` }] };
        },
      ),
    );
  }

  if (params.onHeartbeat) {
    tools.push(
      tool(
        'heartbeat',
        'Optional: signal you are still making progress on a long task. Call every few steps with a one-line note. Does NOT end the task — use report_task_status for that.',
        { progress: z.string().optional() },
        async (args): Promise<ToolResult> => {
          params.onHeartbeat?.({ progress: typeof args.progress === 'string' ? args.progress : undefined });
          return { content: [{ type: 'text', text: 'Heartbeat noted.' }] };
        },
      ),
    );
  }

  if (params.onCreateSubtask) {
    tools.push(
      tool(
        'create_subtask',
        'Decompose this task into an independent subtask. Use it to split work into scoped units — each subtask runs on its own (its own worktree and agent) and starts immediately. Give a clear `prompt` (a full instruction, not a title), an optional short `title`, and optionally the specialist `agent` to run it (e.g. backend, frontend, coder). Returns the new subtask id. Prefer this over doing everything yourself when the work has distinct parts.',
        {
          prompt: z.string(),
          title: z.string().optional(),
          agent: z.string().optional(),
        },
        async (args): Promise<ToolResult> => {
          const created = await params.onCreateSubtask!({
            prompt: String(args.prompt),
            title: typeof args.title === 'string' ? args.title : undefined,
            agent: typeof args.agent === 'string' ? args.agent : undefined,
          });
          return {
            content: [
              { type: 'text', text: `Created and queued subtask ${created.id} — "${created.title}".` },
            ],
          };
        },
      ),
    );
  }

  if (params.onCheckSubtasks) {
    tools.push(
      tool(
        'check_subtasks',
        "Check the current status and latest result of the subtasks you created for this task. Use it to see progress before deciding what to do next. You are also resumed automatically once all subtasks finish, so you don't need to poll in a loop.",
        {},
        async (): Promise<ToolResult> => {
          const subs = await params.onCheckSubtasks!();
          const text = subs.length
            ? subs.map((s) => `- [${s.id}] «${s.title}» → ${s.status}: ${s.summary}`).join('\n')
            : 'No subtasks yet.';
          return { content: [{ type: 'text', text }] };
        },
      ),
    );
  }

  if (params.onScheduleCheck) {
    tools.push(
      tool(
        'schedule_check',
        "Ask to be re-run after a delay — use this instead of claiming you'll 'check back in N minutes' (your run ends now and won't resume on its own). Give `delaySeconds` (30–3600) and an optional `note` of what to re-check. When it fires you're resumed with that note; re-check then (e.g. poll CI via the github MCP), and if it's still not done, call schedule_check again to keep watching. Report your status now and stop — don't sleep or loop in-run.",
        {
          delaySeconds: z.number(),
          note: z.string().optional(),
        },
        async (args): Promise<ToolResult> => {
          const { delaySeconds } = await params.onScheduleCheck!({
            delaySeconds: Number(args.delaySeconds),
            note: typeof args.note === 'string' ? args.note : undefined,
          });
          return {
            content: [{ type: 'text', text: `Scheduled a re-check in ${delaySeconds}s. Ending this run now.` }],
          };
        },
      ),
    );
  }

  if (params.onStartPreview) {
    tools.push(
      tool(
        'preview_worktree',
        'Start (or reuse) a live dev server for THIS task\'s worktree and get its URL, so you can preview your own in-progress changes in the browser (not the base app). Call it before navigating/screenshotting with the browser tools, then open the returned URL. The server is torn down automatically when the task finishes.',
        {},
        async (): Promise<ToolResult> => {
          const { url } = await params.onStartPreview!();
          return {
            content: [
              { type: 'text', text: `Preview of your worktree is live at ${url} — navigate the browser there.` },
            ],
          };
        },
      ),
    );
  }

  if (params.onProposeLearnedSkill) {
    tools.push(
      tool(
        'propose_learned_skill',
        "Propose writing a durable, fleet-wide observation to agent/skills/learned/<name>.md — something future agent runs (not just this one) should know, e.g. a project-specific quirk or gotcha you had to work around. This is NOT for task-specific notes (use report_task_status for those) and NOT for one-off facts — only for things worth a human approving as standing guidance. A human must approve the write before it lands (this call blocks until they decide); `content` should be complete markdown (this REPLACES the file, not appends). Keep it under 16KB — consolidate rather than let it grow unbounded.",
        {
          name: z.string().describe('lowercase-with-hyphens, no extension, e.g. "checkout-service-quirks"'),
          content: z.string(),
        },
        async (args): Promise<ToolResult> => {
          const result = await params.onProposeLearnedSkill!({
            name: String(args.name),
            content: String(args.content),
          });
          return { content: [{ type: 'text', text: result.message }] };
        },
      ),
    );
  }

  return createSdkMcpServer({ name: INTERNAL_MCP_SERVER, version: '1.0.0', tools });
}

/** Fully-qualified names of the internal status tools that are wired for this run. */
function internalToolNames(params: RunAgentParams): string[] {
  const names: string[] = [];
  if (params.onReportStatus) names.push(REPORT_STATUS_TOOL);
  if (params.onHeartbeat) names.push(HEARTBEAT_TOOL);
  if (params.onCreateSubtask) names.push(CREATE_SUBTASK_TOOL);
  if (params.onCheckSubtasks) names.push(CHECK_SUBTASKS_TOOL);
  if (params.onScheduleCheck) names.push(SCHEDULE_CHECK_TOOL);
  if (params.onStartPreview) names.push(PREVIEW_TOOL);
  if (params.onProposeLearnedSkill) names.push(PROPOSE_LEARNED_SKILL_TOOL);
  return names;
}

function blocksToEvents(content: SdkContentBlock[] | string | undefined): AgentEvent[] {
  if (!content) return [];
  if (typeof content === 'string') {
    return content.trim() ? [{ kind: 'assistant', text: content }] : [];
  }
  const events: AgentEvent[] = [];
  for (const block of content) {
    if (block.type === 'text' && block.text?.trim()) {
      events.push({ kind: 'assistant', text: block.text });
    } else if (block.type === 'tool_use') {
      const input = (block.input ?? {}) as Record<string, unknown>;
      // The Task/Agent tool is delegation to a subagent — surface it distinctly.
      if (block.name === 'Task' || block.name === 'Agent') {
        const to = typeof input.subagent_type === 'string' ? input.subagent_type : 'subagent';
        const what = typeof input.description === 'string' ? input.description : '';
        events.push({ kind: 'delegation', text: `→ delegated to ${to}${what ? `: ${what}` : ''}` });
      } else {
        events.push({
          kind: 'tool_use',
          toolName: block.name ?? 'unknown',
          input,
          text: `${block.name ?? 'tool'} ${summarizeInput(input)}`,
        });
      }
    } else if (block.type === 'tool_result') {
      const images = extractImages(block.content);
      events.push({
        kind: 'tool_result',
        text: stringifyToolResult(block.content),
        isError: Boolean(block.is_error),
        ...(images.length ? { images } : {}),
      });
    }
  }
  return events;
}

/** Coerce a possibly-null/undefined SDK numeric field to a finite number (0 otherwise). */
function num(v: number | null | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function summarizeInput(input: Record<string, unknown>): string {
  const cmd = input.command ?? input.file_path ?? input.path ?? input.pattern;
  if (typeof cmd === 'string') return cmd.length > 200 ? `${cmd.slice(0, 200)}…` : cmd;
  const json = JSON.stringify(input);
  return json.length > 200 ? `${json.slice(0, 200)}…` : json;
}

/**
 * Pull base64 images out of a tool result's content. Handles the Anthropic block
 * shape (`{type:'image', source:{type:'base64', media_type, data}}`) and the MCP
 * passthrough shape (`{type:'image', data, mimeType}`). URL sources are skipped.
 */
function extractImages(content: unknown): { data: string; mediaType: string }[] {
  if (!Array.isArray(content)) return [];
  const out: { data: string; mediaType: string }[] = [];
  for (const b of content) {
    if (!b || typeof b !== 'object' || (b as { type?: string }).type !== 'image') continue;
    const blk = b as {
      source?: { type?: string; data?: unknown; media_type?: unknown; mediaType?: unknown };
      data?: unknown;
      mimeType?: unknown;
      media_type?: unknown;
    };
    const s = blk.source;
    if (s && typeof s.data === 'string') {
      out.push({ data: s.data, mediaType: String(s.media_type ?? s.mediaType ?? 'image/png') });
    } else if (typeof blk.data === 'string') {
      out.push({ data: blk.data, mediaType: String(blk.mimeType ?? blk.media_type ?? 'image/png') });
    }
  }
  return out;
}

function stringifyToolResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === 'object' && c && 'text' in c ? String((c as { text: unknown }).text) : ''))
      .join('');
  }
  return content ? JSON.stringify(content) : '';
}

/**
 * Run (or resume) one headless Claude Code agent for a task. The right model/
 * endpoint is injected per the task tier; the agent is confined to its worktree
 * (cwd); a generated settings.json wires the PreToolUse approval hook.
 *
 * Emits normalized {@link AgentEvent}s via `onEvent` and resolves with the final
 * result (including the Claude session id for later --resume).
 */
export async function runAgent(
  params: RunAgentParams,
  onEvent: AgentEventHandler,
): Promise<AgentRunResult> {
  const env = buildAgentEnv(params.modelEnv, process.env, params.workspaceRoot ?? params.cwd, params.hook);
  if (params.skillsDir) env.LDS_SKILLS_DIR = params.skillsDir;
  if (params.attachmentsDir) env.LDS_ATTACHMENTS_DIR = params.attachmentsDir;
  const settingsDir = params.settingsDir ?? join(params.cwd, '.lds');
  const settingsPath = await writeAgentSettings(settingsDir, params.hook);

  const { query, tool, createSdkMcpServer } = await esmImport('@anthropic-ai/claude-agent-sdk');

  // Merge the agent's declared MCP servers with our in-process status server.
  const statusServer = buildStatusServer(params, tool, createSdkMcpServer);
  const mcpServers: Record<string, unknown> = {
    ...(params.mcpServers ?? {}),
    ...(statusServer ? { [INTERNAL_MCP_SERVER]: statusServer } : {}),
  };

  // `allowedTools` is an exclusive whitelist — if one is set, our in-process
  // status tools must be added or the agent could never report (→ stalled).
  const allowedTools =
    params.allowedTools?.length && statusServer
      ? [...params.allowedTools, ...internalToolNames(params)]
      : params.allowedTools;

  const result: AgentRunResult = {
    sessionId: params.resumeSessionId ?? null,
    isError: false,
    result: '',
    maxTurnsExceeded: false,
    usage: emptyUsage(),
  };

  const stream = query({
    prompt: params.prompt,
    options: {
      cwd: params.cwd,
      env,
      maxTurns: params.maxTurns,
      resume: params.resumeSessionId,
      ...(params.appendSystemPrompt
        ? {
            systemPrompt: {
              type: 'preset' as const,
              preset: 'claude_code' as const,
              append: params.appendSystemPrompt,
            },
          }
        : {}),
      ...(allowedTools?.length ? { allowedTools } : {}),
      ...(params.disallowedTools?.length ? { disallowedTools: params.disallowedTools } : {}),
      ...(Object.keys(mcpServers).length ? { mcpServers } : {}),
      ...(params.agents && Object.keys(params.agents).length ? { agents: params.agents } : {}),
      settings: settingsPath,
      // Isolate from the host's user/project settings; we provide everything.
      settingSources: [],
      // The PreToolUse hook is authoritative; default mode defers to it.
      permissionMode: 'default',
      abortController: params.abortController,
      stderr: (data: string) => onEvent({ kind: 'stderr', text: data }),
    },
  });

  try {
    for await (const msg of stream) {
      if (msg.type === 'system' && msg.subtype === 'init') {
        result.sessionId = msg.session_id ?? result.sessionId;
        const mcp = msg.mcp_servers?.length
          ? ` · mcp: ${msg.mcp_servers.map((s) => `${s.name}=${s.status ?? '?'}`).join(', ')}`
          : ' · mcp: (none reported)';
        onEvent({
          kind: 'system',
          sessionId: msg.session_id ?? '',
          model: msg.model ?? params.modelLabel,
          text: `agent started — provider=${params.providerLabel} model=${msg.model ?? params.modelLabel}${mcp}`,
        });
      } else if (msg.type === 'assistant') {
        for (const ev of blocksToEvents(msg.message?.content)) onEvent(ev);
      } else if (msg.type === 'user') {
        for (const ev of blocksToEvents(msg.message?.content)) onEvent(ev);
      } else if (msg.type === 'result') {
        result.isError = Boolean(msg.is_error);
        result.result = msg.result ?? '';
        result.maxTurnsExceeded =
          msg.subtype === 'error_max_turns' || /maximum number of turns/i.test(result.result);
        // Usage arrives on the result message (snake_case, per the SDK's
        // NonNullableUsage). Coerce null/undefined → 0 so downstream stats never
        // see NaN. `num_turns` ≈ requests; `total_cost_usd` is SDK-estimated.
        const u = msg.usage ?? {};
        result.usage = {
          inputTokens: num(u.input_tokens),
          outputTokens: num(u.output_tokens),
          cacheReadTokens: num(u.cache_read_input_tokens),
          cacheCreationTokens: num(u.cache_creation_input_tokens),
          numTurns: num(msg.num_turns),
          costUsd: num(msg.total_cost_usd),
          apiMs: num(msg.duration_api_ms),
        };
        onEvent({
          kind: 'result',
          isError: Boolean(msg.is_error),
          text: msg.result ?? (msg.is_error ? 'agent run errored' : 'agent run completed'),
          numTurns: msg.num_turns ?? 0,
          costUsd: msg.total_cost_usd ?? 0,
        });
      }
    }
  } catch (err) {
    // The SDK throws (AbortError, transport failures, …) instead of emitting a
    // final `result`. Always close the transcript with a result event so the
    // orchestrator never sees a session that just stops mid-stream.
    const aborted = params.abortController?.signal.aborted ?? false;
    const message = err instanceof Error ? err.message : String(err);
    result.isError = true;
    result.result = aborted ? 'agent run aborted' : message;
    onEvent({ kind: 'result', isError: true, text: result.result, numTurns: 0, costUsd: 0 });
    // An abort is an expected, orchestrator-driven stop — resolve cleanly and let
    // the caller interpret it (cancel vs. timeout). Anything else is a real error.
    if (!aborted) throw err;
  }

  return result;
}
