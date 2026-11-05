/** One plain question to a model (no tools, no images) through a provider's chat endpoint — Anthropic messages or OpenAI-style completions. */
export interface ChatEndpoint {
  style: 'anthropic' | 'openai';
  url: string;
  headers: Record<string, string>;
  model: string;
}

/**
 * Ask once. A reasoning model (DeepSeek, Gemini, o-series …) spends the token budget on thinking it does not return: with a few tokens allowed the reply
 * is EMPTY and the answer was cut ("length"). Then the question is asked once more with a budget the thinking fits in.
 */
export async function chatOnce(ep: ChatEndpoint, o: { system: string; user: string; maxTokens?: number; timeoutMs?: number }): Promise<string> {
  const max = o.maxTokens ?? 60;
  const first = await ask(ep, o, max);
  if (first.text || !first.cut) return first.text;
  // only with a bigger budget: asking again with the same one would be the same answer, paid for twice
  const more = Math.min(1500, Math.max(400, max * 8));
  if (more <= max) return first.text;
  return (await ask(ep, o, more)).text;
}

async function ask(ep: ChatEndpoint, o: { system: string; user: string; timeoutMs?: number }, max: number): Promise<{ text: string; cut: boolean }> {
  const body =
    ep.style === 'anthropic'
      ? { model: ep.model, max_tokens: max, system: o.system, messages: [{ role: 'user', content: o.user }] }
      : { model: ep.model, max_tokens: max, temperature: 0.2, messages: [{ role: 'system', content: o.system }, { role: 'user', content: o.user }] };
  const res = await fetch(ep.url, { method: 'POST', headers: { ...ep.headers, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(o.timeoutMs ?? 20_000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 160)}`);
  const j = JSON.parse(text) as { content?: { type: string; text?: string }[]; stop_reason?: string; choices?: { message?: { content?: string }; finish_reason?: string }[] };
  const reply = (ep.style === 'anthropic' ? (j.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('') : (j.choices?.[0]?.message?.content ?? '')).trim();
  const cut = ep.style === 'anthropic' ? j.stop_reason === 'max_tokens' : j.choices?.[0]?.finish_reason === 'length';
  return { text: reply, cut };
}
