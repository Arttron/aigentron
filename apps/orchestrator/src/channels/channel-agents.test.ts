import { describe, expect, it } from 'vitest';
import { ChannelCommandService } from './channel-commands.service';

const agentList = [
  { name: 'pm', description: 'Product manager' },
  { name: 'architect', description: 'Designs the system' },
  { name: 'backend-dev', description: 'Backend' },
  { name: 'frontend-dev', description: 'Frontend' },
  { name: 'tasks', description: 'clashes with the /tasks command' },
];

function service() {
  const agents = { list: async () => agentList };
  const settings = { defaultAgent: async () => 'pm' };
  const channels = { chatState: async () => ({ agent: null }) };
  return new ChannelCommandService({} as never, {} as never, channels as never, {} as never, {} as never, {} as never, agents as never, settings as never, {} as never);
}

describe('addressing agents from a chat', () => {
  it('/name and @name reach the agent; typos are forgiven and flagged as fuzzy', async () => {
    const s = service();
    expect(await s.resolveAddress('/pm make the report')).toEqual({ agent: 'pm', rest: 'make the report', typed: 'pm', fuzzy: false });
    expect(await s.resolveAddress('@PM hello')).toMatchObject({ agent: 'pm', fuzzy: false });
    expect(await s.resolveAddress('/arhcitect design it')).toMatchObject({ agent: 'architect', rest: 'design it', fuzzy: true });
    expect(await s.resolveAddress('@bakend_dev fix')).toMatchObject({ agent: 'backend-dev', fuzzy: true });
    expect(await s.resolveAddress('/Backend_Dev')).toMatchObject({ agent: 'backend-dev', rest: '', fuzzy: false });
  });
  it('built-in commands stay commands; unknown @words are plain text', async () => {
    const s = service();
    expect(await s.resolveAddress('/tasks')).toBeNull();
    expect(await s.resolveAddress('/new_task something')).toBeNull();
    expect(await s.resolveAddress('@somebody thanks')).toBeNull();
    expect(await s.resolveAddress('plain text')).toBeNull();
  });
  it('an agent named like a command is reached with @name only', async () => {
    const s = service();
    expect(await s.resolveAddress('@tasks do')).toMatchObject({ agent: 'tasks' });
    const cmds = (await s.agentCommands()).map((c) => c.command);
    expect(cmds).toContain('pm');
    expect(cmds).toContain('backend_dev');
    expect(cmds).not.toContain('tasks');
  });
  it('says so when two agents fit, and suggests close names for an unknown /word', async () => {
    const s = service();
    const amb = await s.resolveAddress('/dev');
    expect(amb && 'reply' in amb ? amb.reply : '').toMatch(/\/backend_dev.*\/frontend_dev|\/frontend_dev.*\/backend_dev/);
    expect(await s.resolveAddress('/zzzz')).toBeNull();
  });
  it('command menu entries are valid Telegram commands with descriptions', async () => {
    const cmds = await service().agentCommands();
    for (const c of cmds) {
      expect(c.command).toMatch(/^[a-z0-9_]{1,32}$/);
      expect(c.description.length).toBeGreaterThan(0);
      expect(c.description.length).toBeLessThanOrEqual(100);
    }
  });

  it('/agents lists tappable /names with their descriptions and marks the default', async () => {
    const out = await service().handle({ channelId: 'c', chatId: '1', userId: 'u', kind: 'telegram' }, '/agents');
    const text = typeof out === 'string' ? out : out.text;
    expect(text).toContain('▶ /pm — Product manager');
    expect(text).toContain('· /architect — Designs the system');
    expect(text).toContain('· /backend_dev — Backend');
    expect(text).toContain('@tasks'); // no command of its own
    expect(text).toMatch(/small typos/);
  });
});
