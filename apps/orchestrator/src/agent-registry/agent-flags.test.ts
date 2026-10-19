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
