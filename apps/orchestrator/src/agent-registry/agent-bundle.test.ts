import { describe, expect, it } from 'vitest';
import { planImport, validateBundle, type AgentBundle } from './agent-bundle';

const base = (): AgentBundle => ({
  format: 'aigentron-agent',
  version: 1,
  exportedAt: 'x',
  agent: { name: 'pm', content: '---\ndescription: d\n---\nhi' },
  skills: [{ name: 'tips', kind: 'learned', content: 'a' }],
});

describe('validateBundle', () => {
  it('accepts a good bundle', () => expect(validateBundle(base()).bundle?.agent.name).toBe('pm'));
  it('rejects foreign formats, bad names, oversized and duplicate items', () => {
    expect(validateBundle({}).errors.length).toBe(1);
    expect(validateBundle({ ...base(), agent: { name: '../x', content: '' } }).errors.join()).toMatch(/Invalid agent name/);
    expect(validateBundle({ ...base(), skills: [{ name: 'a', kind: 'learned', content: 'x'.repeat(16001) }] }).errors.join()).toMatch(/over/);
    const dup = { ...base(), skills: [base().skills[0], base().skills[0]] };
    expect(validateBundle(dup).errors.join()).toMatch(/twice/);
  });
});

describe('planImport', () => {
  it('new items are written, different ones only when chosen, same ones never, builtin and shipped names are blocked', () => {
    const b = base();
    const ex = new Map([['skill:learned:tips', 'old']]);
    let plan = planImport(b, ex, new Set(), {});
    expect(plan.map((i) => [i.key, i.status, i.write])).toEqual([['agent:pm', 'new', true], ['skill:learned:tips', 'different', false]]);
    plan = planImport(b, ex, new Set(), { overwrite: ['skill:learned:tips'] });
    expect(plan[1].write).toBe(true);
    expect(planImport(b, new Map([['skill:learned:tips', 'a']]), new Set(), {})[1].status).toBe('same');
    expect(planImport(b, new Map(), new Set(), { agentName: 'admin' })[0].status).toBe('blocked');
    expect(planImport(b, new Map(), new Set(['tips']), {})[1].status).toBe('blocked');
  });
});
