/** One plain question to a model (no tools, no images) through a provider's chat endpoint — Anthropic messages or OpenAI-style completions. */
export interface ChatEndpoint {
  style: 'anthropic' | 'openai';
  url: string;
  headers: Record<string, string>;
  model: string;
}

export async function chatOnce(ep: ChatEndpoint, o: { system: string; user: string; maxTokens?: number; timeoutMs?: number }): Promise<string> {
  const max = o.maxTokens ?? 60;
  const body =
    ep.style === 'anthropic'
      ? { model: ep.model, max_tokens: max, system: o.system, messages: [{ role: 'user', content: o.user }] }
      : { model: ep.model, max_tokens: max, temperature: 0.2, messages: [{ role: 'system', content: o.system }, { role: 'user', content: o.user }] };
  const res = await fetch(ep.url, { method: 'POST', headers: { ...ep.headers, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(o.timeoutMs ?? 20_000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 160)}`);
  const j = JSON.parse(text) as { content?: { type: string; text?: string }[]; choices?: { message?: { content?: string } }[] };
  return (ep.style === 'anthropic' ? (j.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('') : (j.choices?.[0]?.message?.content ?? '')).trim();
}
