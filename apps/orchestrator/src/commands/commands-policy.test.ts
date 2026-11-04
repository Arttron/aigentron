import { describe, expect, it } from 'vitest';
import { mcpWithCommands } from './commands-policy';

const on = { enabled: true, chat: false, discussion: false };
describe('mcpWithCommands', () => {
  it('adds the pipeline to a working agent', () => expect(mcpWithCommands(['github'], on)).toEqual(['github', 'commands']));
  it('does not duplicate it', () => expect(mcpWithCommands(['commands'], on)).toEqual(['commands']));
  it('adds nothing when it is switched off, for a chat or question run, or a discussion', () => {
    expect(mcpWithCommands([], { ...on, enabled: false })).toEqual([]);
    expect(mcpWithCommands([], { ...on, chat: true })).toEqual([]);
    expect(mcpWithCommands([], { ...on, discussion: true })).toEqual([]);
  });
  it('adds nothing for an agent that may not use Bash (it would give the shell back)', () => {
    expect(mcpWithCommands([], { ...on, disallowedTools: ['Bash'] })).toEqual([]);
    expect(mcpWithCommands([], { ...on, disallowedTools: ['Write'] })).toEqual(['commands']);
  });
  it('adds nothing for an agent whose tools leave out Bash', () => {
    expect(mcpWithCommands([], { ...on, allowedTools: ['Read', 'Grep'] })).toEqual([]);
    expect(mcpWithCommands([], { ...on, allowedTools: ['Read', 'Bash'] })).toEqual(['commands']);
  });
});
