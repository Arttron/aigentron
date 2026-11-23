/** Pure helpers of the local-model proxy: which computer serves a model, and folding a streamed answer back into one completion. */

export interface SharedModel {
  deviceId: string;
  deviceLabel: string;
  backend: string;
  id: string;
}

/** `qwen3-coder:30b` (any computer that shares it) or `qwen3-coder:30b@laptop` (that computer's label). The LAST `@` splits, so model names containing `@` still work. */
export function parseModelRef(ref: string): { model: string; label?: string } {
  const at = ref.lastIndexOf('@');
  return at > 0 && at < ref.length - 1 ? { model: ref.slice(0, at), label: ref.slice(at + 1) } : { model: ref };
}

/** The computer (and backend) to use for a model reference: the first match in the given order (callers pass online computers, most recently seen first). */
export function pickModel(models: SharedModel[], ref: string): SharedModel | null {
  const { model, label } = parseModelRef(ref);
  return models.find((m) => m.id === model && (!label || m.deviceLabel === label)) ?? null;
}

/** What `/v1/models` lists: every shared model, plus `model@computer` for each when the same model is on several computers. */
export function listIds(models: SharedModel[]): string[] {
  const ids = new Set<string>();
  const count = new Map<string, number>();
  for (const m of models) count.set(m.id, (count.get(m.id) ?? 0) + 1);
  for (const m of models) {
    ids.add(m.id);
    if ((count.get(m.id) ?? 0) > 1) ids.add(`${m.id}@${m.deviceLabel}`);
  }
  return [...ids].sort();
}

interface Delta {
  role?: string;
  content?: string | null;
  tool_calls?: { index?: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }[];
}
interface Chunk {
  id?: string;
  model?: string;
  created?: number;
  choices?: { index?: number; delta?: Delta; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

/** Fold server-sent chunks (OpenAI chat.completion.chunk) into one chat.completion — for a caller that did not ask for a stream. */
export function aggregate(payloads: string[], model: string): Record<string, unknown> {
  let id = '';
  let created = 0;
  let content = '';
  let finish: string | null = null;
  let usage: Chunk['usage'];
  const calls = new Map<number, { id: string; type: string; function: { name: string; arguments: string } }>();
  for (const p of payloads) {
    let c: Chunk;
    try {
      c = JSON.parse(p) as Chunk;
    } catch {
      continue;
    }
    id ||= c.id ?? '';
    created ||= c.created ?? 0;
    if (c.usage) usage = c.usage;
    const ch = c.choices?.[0];
    if (!ch) continue;
    if (ch.delta?.content) content += ch.delta.content;
    for (const t of ch.delta?.tool_calls ?? []) {
      const i = t.index ?? 0;
      const cur = calls.get(i) ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (t.id) cur.id = t.id;
      if (t.function?.name) cur.function.name += t.function.name;
      if (t.function?.arguments) cur.function.arguments += t.function.arguments;
      calls.set(i, cur);
    }
    if (ch.finish_reason) finish = ch.finish_reason;
  }
  const tool_calls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([i, c]) => ({ ...c, id: c.id || `call_${i}` }));
  return {
    id: id || 'local-chat',
    object: 'chat.completion',
    created: created || Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: content || (tool_calls.length ? null : ''), ...(tool_calls.length ? { tool_calls } : {}) }, finish_reason: finish ?? (tool_calls.length ? 'tool_calls' : 'stop') }],
    ...(usage ? { usage } : {}),
  };
}

/**
 * What the endpoint says when the computer cannot serve a request. The wording is chosen so the platform's failover recognises it (FAILOVER_PATTERNS in
 * agent/run-outcome.ts) and moves the run to the agent's next provider; a test keeps the two in step. `status` is the HTTP code sent to LiteLLM.
 */
export function unavailable(kind: 'no-model' | 'offline' | 'stalled' | 'failed', detail = ''): { status: number; message: string } {
  switch (kind) {
    case 'no-model':
      return { status: 503, message: `Service unavailable: the local computer is offline or does not share this model (model not found). ${detail}`.trim() };
    case 'offline':
      return { status: 503, message: `Service unavailable: the local computer is offline (connection closed). ${detail}`.trim() };
    case 'stalled':
      return { status: 504, message: `Gateway timeout: the local model stopped answering. ${detail}`.trim() };
    default:
      return { status: 502, message: `Bad gateway: the local computer could not answer. ${detail}`.trim() };
  }
}

/** Is a bridge error the "line is down" kind (as opposed to a refusal or a model error)? */
export const isLineDown = (error: string | undefined): boolean => /offline|did not answer in time|could not reach/i.test(error ?? '');
