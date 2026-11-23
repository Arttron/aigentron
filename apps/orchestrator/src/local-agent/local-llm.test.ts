import { describe, expect, it } from 'vitest';
import { FAILOVER_PATTERNS, classifyProviderFailure } from '../agent/run-outcome';
import { COOLDOWN_MS, ProviderCooldown } from '../agent/provider-cooldown';
import { aggregate, isLineDown, listIds, parseModelRef, pickModel, unavailable, type SharedModel } from './local-llm';

const m = (deviceLabel: string, id: string, backend = 'ollama'): SharedModel => ({ deviceId: `d-${deviceLabel}`, deviceLabel, backend, id });

describe('model references', () => {
  it('splits a pin on the last @', () => {
    expect(parseModelRef('qwen3-coder:30b')).toEqual({ model: 'qwen3-coder:30b' });
    expect(parseModelRef('qwen3-coder:30b@laptop')).toEqual({ model: 'qwen3-coder:30b', label: 'laptop' });
    expect(parseModelRef('hf.co/a@b/model:Q8@laptop')).toEqual({ model: 'hf.co/a@b/model:Q8', label: 'laptop' });
    expect(parseModelRef('@x')).toEqual({ model: '@x' });
    expect(parseModelRef('x@')).toEqual({ model: 'x@' });
  });
  it('picks the first computer that shares the model, or the pinned one', () => {
    const all = [m('desk', 'qwen'), m('laptop', 'qwen'), m('laptop', 'llama')];
    expect(pickModel(all, 'qwen')?.deviceLabel).toBe('desk');
    expect(pickModel(all, 'qwen@laptop')?.deviceLabel).toBe('laptop');
    expect(pickModel(all, 'llama')?.deviceLabel).toBe('laptop');
    expect(pickModel(all, 'qwen@phone')).toBeNull();
    expect(pickModel(all, 'nope')).toBeNull();
  });
  it('lists a pinned form only for models on several computers', () => {
    expect(listIds([m('desk', 'qwen'), m('laptop', 'qwen'), m('laptop', 'llama')])).toEqual(['llama', 'qwen', 'qwen@desk', 'qwen@laptop']);
    expect(listIds([])).toEqual([]);
  });
});

describe('aggregate', () => {
  const c = (delta: object, finish: string | null = null, extra: object = {}) => JSON.stringify({ id: 'cmpl-1', created: 5, choices: [{ index: 0, delta, finish_reason: finish }], ...extra });
  it('joins text deltas', () => {
    const r = aggregate([c({ role: 'assistant', content: 'Hel' }), c({ content: 'lo' }), c({}, 'stop', { usage: { total_tokens: 7 } })], 'q') as { choices: { message: { content: string }; finish_reason: string }[]; usage: unknown; model: string };
    expect(r.choices[0]!.message.content).toBe('Hello');
    expect(r.choices[0]!.finish_reason).toBe('stop');
    expect(r.usage).toEqual({ total_tokens: 7 });
    expect(r.model).toBe('q');
  });
  it('rebuilds tool calls from fragments', () => {
    const r = aggregate([
      c({ tool_calls: [{ index: 0, id: 'a', function: { name: 'create_sub', arguments: '{"prom' } }] }),
      c({ tool_calls: [{ index: 0, function: { name: 'task', arguments: 'pt":"x"}' } }] }),
      c({ tool_calls: [{ index: 1, function: { name: 'check', arguments: '{}' } }] }),
      c({}, 'tool_calls'),
    ], 'q') as { choices: { message: { content: null; tool_calls: { id: string; function: { name: string; arguments: string } }[] }; finish_reason: string }[] };
    const msg = r.choices[0]!.message;
    expect(msg.content).toBeNull();
    expect(msg.tool_calls.map((t) => [t.id, t.function.name, t.function.arguments])).toEqual([['a', 'create_subtask', '{"prompt":"x"}'], ['call_1', 'check', '{}']]);
    expect(JSON.parse(msg.tool_calls[0]!.function.arguments)).toEqual({ prompt: 'x' });
    expect(r.choices[0]!.finish_reason).toBe('tool_calls');
  });
  it('survives junk and an empty answer', () => {
    const r = aggregate(['not json', '{}', c({ content: 'ok' })], 'q') as { choices: { message: { content: string } }[] };
    expect(r.choices[0]!.message.content).toBe('ok');
    expect((aggregate([], 'q') as { choices: { message: { content: string } }[] }).choices[0]!.message.content).toBe('');
  });
});

describe('a local model that cannot answer hands the run to the next provider', () => {
  const kinds = ['no-model', 'offline', 'stalled', 'failed'] as const;
  it.each(kinds)('%s is recognised by the platform failover', (k) => {
    const { message, status } = unavailable(k, 'x');
    expect(FAILOVER_PATTERNS.some((re) => re.test(message)), message).toBe(true);
    expect(status).toBeGreaterThanOrEqual(502);
  });
  it('an unreachable computer cools for a minute, not for good', () => {
    for (const k of ['no-model', 'offline'] as const) expect(classifyProviderFailure(unavailable(k).message)).toBe('offline');
    expect(classifyProviderFailure(unavailable('stalled').message)).not.toBe('offline');
    let now = 0;
    const c = new ProviderCooldown(() => now);
    expect(c.mark('local-llm', 'offline')).toBe(COOLDOWN_MS.offline);
    expect(c.isCooling('local-llm')).toBe(true);
    now = COOLDOWN_MS.offline + 1;
    expect(c.isCooling('local-llm')).toBe(false); // back on it as soon as the computer may be back
  });
  it('tells a dead line from a model error', () => {
    expect(isLineDown('the local agent is offline')).toBe(true);
    expect(isLineDown('the local agent did not answer in time')).toBe(true);
    expect(isLineDown('the model "x" is not shared from that computer')).toBe(false);
  });
});
