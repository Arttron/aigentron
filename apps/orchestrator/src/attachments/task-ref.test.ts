import { describe, expect, it } from 'vitest';
import { parseTaskRef, taskRef } from './task-ref';

describe('task file references', () => {
  it('parses task:<id>/<name> and rebuilds it', () => {
    expect(parseTaskRef('task:cmv123abc/plan v2.png')).toEqual({ taskId: 'cmv123abc', name: 'plan v2.png' });
    expect(taskRef('t-1', 'a.png')).toBe('task:t-1/a.png');
  });
  it('refuses paths, hidden files and anything else', () => {
    for (const v of ['task:abc/../x', 'task:abc/a/b.png', 'task:abc/.links.json', 'task:/a.png', 'task:abc', 'plan.png', '/etc/passwd', 'task:ab c/a.png', 'task:abc/']) expect(parseTaskRef(v), v).toBeNull();
  });
});
