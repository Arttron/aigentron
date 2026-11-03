import { describe, expect, it } from 'vitest';
import { parseAgentMarkdown } from './agent-registry.service';

describe('agent file flags', () => {
  it('createTasks is off unless the file says so', () => {
    expect(parseAgentMarkdown('---\ndescription: x\n---\nbody', 'pm').createTasks).toBeUndefined();
    expect(parseAgentMarkdown('---\ndescription: x\ncreateTasks: false\n---\nbody', 'pm').createTasks).toBeUndefined();
  });
  it('createTasks: true turns the create_task tool on for that agent', () => {
    expect(parseAgentMarkdown('---\ndescription: x\ncreateTasks: true\n---\nbody', 'pm').createTasks).toBe(true);
    expect(parseAgentMarkdown('---\ncreateTasks: yes\n---\nbody', 'pm').createTasks).toBe(true);
  });
});

import { parseMaxTurns } from './agent-registry.service';

describe('maxTurns', () => {
  it('reads a whole number from 5 to 500 and ignores anything else', () => {
    expect(parseAgentMarkdown('---\ndescription: x\nmaxTurns: 80\n---\nbody', 'pm').maxTurns).toBe(80);
    for (const bad of ['', 'abc', '4', '501', '12.5', '-3', '1000']) expect(parseMaxTurns(bad)).toBeUndefined();
    expect(parseMaxTurns('5')).toBe(5);
    expect(parseMaxTurns('500')).toBe(500);
    expect(parseAgentMarkdown('---\ndescription: x\n---\nbody', 'pm').maxTurns).toBeUndefined();
  });
});

describe('tier (model strength override)', () => {
  it('reads cheap | mid | top, ignores anything else, and is absent by default', () => {
    for (const t of ['cheap', 'mid', 'top']) expect(parseAgentMarkdown(`---\ndescription: x\ntier: ${t}\n---\nb`, 'a').tier).toBe(t);
    expect(parseAgentMarkdown('---\ndescription: x\ntier: huge\n---\nb', 'a').tier).toBeUndefined();
    expect(parseAgentMarkdown('---\ndescription: x\n---\nb', 'a').tier).toBeUndefined();
  });
});
