import { describe, expect, it } from 'vitest';
import { ClipService } from './clip.service';

/** "Send to Aigentron" into a task that already exists: the picture is saved among the task's files, then the message names it. */
function make(opts: { exists?: boolean } = {}) {
  const calls: string[] = [];
  const tasks = {
    getLite: async (id: string) => {
      if (opts.exists === false) throw Object.assign(new Error('Task not found'), { status: 404 });
      return { id, title: 'Fix the checkout' };
    },
    followUp: async (id: string, prompt: string, attachments?: string[]) => void calls.push(`followUp:${id}:${attachments?.join(',') ?? '-'}:${prompt.split('\n')[0]}`),
    create: async () => void calls.push('create'),
  };
  const attachments = { save: async (id: string, name: string) => (calls.push(`save:${id}:${name}`), { name: 'page-screenshot.jpg' }) };
  const svc = new ClipService(tasks as never, attachments as never, {} as never, {} as never);
  return { svc, calls };
}
const body = { mode: 'followup', taskId: 't1', prompt: 'Look at this', page: { url: 'https://example.com', title: 'Example' }, screenshot: 'QUJD' };

describe('ClipService: followup', () => {
  it('saves the screenshot to the task, then sends the message naming it', async () => {
    const { svc, calls } = make();
    const r = await svc.clip(body, { id: 'u', role: 'operator' });
    expect(r).toEqual({ kind: 'followup', id: 't1', path: '/tasks/t1', title: 'Fix the checkout' });
    expect(calls).toEqual(['save:t1:page-screenshot.jpg', 'followUp:t1:page-screenshot.jpg:Look at this']);
  });
  it('without a screenshot it is just the message', async () => {
    const { svc, calls } = make();
    await svc.clip({ ...body, screenshot: undefined }, { id: 'u', role: 'task_setter' });
    expect(calls).toEqual(['followUp:t1:-:Look at this']);
  });
  it('a role that cannot write to tasks is refused, and nothing is saved', async () => {
    const { svc, calls } = make();
    await expect(svc.clip(body, { id: 'u', role: 'viewer' })).rejects.toThrow(/cannot write to tasks/);
    expect(calls).toEqual([]);
  });
  it('an unknown task is not found, and no picture is left behind', async () => {
    const { svc, calls } = make({ exists: false });
    await expect(svc.clip(body, { id: 'u', role: 'operator' })).rejects.toThrow(/not found/i);
    expect(calls).toEqual([]);
  });
});
