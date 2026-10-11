import { describe, expect, it } from 'vitest';
import { TASK_TYPES, isTaskType, typeWhere } from './task-types';

describe('task types', () => {
  it('knows the six types', () => {
    expect([...TASK_TYPES]).toEqual(['task', 'subtask', 'chat', 'scheduled', 'channel', 'discussion']);
    expect(isTaskType('chat')).toBe(true);
    expect(isTaskType('nope')).toBe(false);
    expect(isTaskType(undefined)).toBe(false);
  });
  it('builds a where clause per type; chat agents drive "chat" and "task"', () => {
    expect(typeWhere('discussion', [])).toEqual({ kind: 'discussion' });
    expect(typeWhere('subtask', [])).toMatchObject({ parentId: { not: null } });
    expect(typeWhere('scheduled', [])).toMatchObject({ createdByChannel: { startsWith: 'schedule:' } });
    expect(typeWhere('chat', ['admin'])).toMatchObject({ createdByChannel: null, agentName: { in: ['admin'] } });
    const task = typeWhere('task', ['admin']) as { OR: unknown[] };
    expect(task.OR).toEqual([{ agentName: null }, { agentName: { notIn: ['admin'] } }]);
  });
});
