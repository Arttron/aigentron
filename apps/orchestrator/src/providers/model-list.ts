/** Model lists: Anthropic's /v1/models is paginated (20 per page by default) — read every page; a subscription login cannot list at all. */

export interface ModelPage {
  ids: string[];
  /** `after_id` for the next page, or null at the end. */
  next: string | null;
}

/** One page of GET /v1/models (Anthropic: `{data:[{id}], has_more, last_id}`; OpenAI-style: `{data:[…]}`, a bare array, or strings). */
export function parseModelPage(json: unknown): ModelPage {
  const body = json as { data?: unknown; has_more?: unknown; last_id?: unknown } | unknown[] | null;
  const rows: unknown[] = Array.isArray(body) ? body : Array.isArray((body as { data?: unknown })?.data) ? ((body as { data: unknown[] }).data) : [];
  const ids = rows
    .map((m) => (typeof m === 'string' ? m : (m as { id?: unknown })?.id))
    .filter((x): x is string => typeof x === 'string' && x.length > 0);
  const o = Array.isArray(body) ? null : body;
  const next = o && o.has_more === true && typeof o.last_id === 'string' && o.last_id ? o.last_id : null;
  return { ids, next };
}

/** The Claude models a subscription (OAuth) login can use — listing is not possible with that token, so the picker offers these (any other name can still be typed). */
export const CLAUDE_SUBSCRIPTION_MODELS: readonly string[] = [
  'claude-fable-5-1',
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'claude-haiku-4-5-20251001',
  'opus',
  'sonnet',
  'haiku',
];
