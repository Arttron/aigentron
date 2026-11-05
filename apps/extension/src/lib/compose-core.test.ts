import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JavaScript module (the extension has no build step for its own sources)
import { buildClip, filterTasks, statusLabel } from './compose-core.js';

const draft = { url: 'https://example.com/pricing', title: 'Pricing', text: 'page text', selection: '', bug: null };
const base = { draft, prompt: ' look at this ', project: 'web', agentName: 'frontend', kb: '', taskId: '', includeText: false, includeSelection: false, includeBug: false, screenshot: 'QUJD' };

describe('buildClip', () => {
  it('a new task: the project, the agent, the screenshot', () => {
    expect(buildClip({ ...base, mode: 'task' })).toMatchObject({ mode: 'task', project: 'web', agentName: 'frontend', prompt: 'look at this', screenshot: 'QUJD' });
  });
  it('a message in an existing task: the task, no project / agent; the screenshot goes along', () => {
    const b = buildClip({ ...base, mode: 'followup', taskId: 't42' });
    expect(b).toMatchObject({ mode: 'followup', taskId: 't42', screenshot: 'QUJD', prompt: 'look at this' });
    expect(b).not.toHaveProperty('project');
    expect(b).not.toHaveProperty('agentName');
  });
  it('a note: no screenshot, the base', () => {
    const b = buildClip({ ...base, mode: 'kb', kb: 'notes' });
    expect(b).toMatchObject({ mode: 'kb', kb: 'notes', project: 'web' });
    expect(b).not.toHaveProperty('screenshot');
  });
  it('bug data goes to a task or a message, never to a note', () => {
    const bug = { console: [], network: [], errors: [] };
    const s = { ...base, includeBug: true, draft: { ...draft, bug } };
    expect(buildClip({ ...s, mode: 'followup', taskId: 't1' })).toHaveProperty('bug');
    expect(buildClip({ ...s, mode: 'task' })).toHaveProperty('bug');
    expect(buildClip({ ...s, mode: 'kb', kb: 'k' })).not.toHaveProperty('bug');
  });
});

describe('filterTasks', () => {
  const tasks = [
    { id: 'a', title: 'Fix the checkout total', status: 'running', projectSlug: 'shop', updatedAt: '2026-11-01T10:00:00Z' },
    { id: 'b', title: 'Landing hero', status: 'review', projectSlug: 'web', updatedAt: '2026-11-03T10:00:00Z' },
    { id: 'c', title: 'Mobile menu overlaps the logo', status: 'blocked', projectSlug: 'web', updatedAt: '2026-11-02T10:00:00Z' },
  ];
  it('newest first; a filter matches the title, project or status', () => {
    expect(filterTasks(tasks, '').map((t: { id: string }) => t.id)).toEqual(['b', 'c', 'a']);
    expect(filterTasks(tasks, 'checkout').map((t: { id: string }) => t.id)).toEqual(['a']);
    expect(filterTasks(tasks, 'WEB').map((t: { id: string }) => t.id)).toEqual(['b', 'c']);
    expect(filterTasks(tasks, 'blocked').map((t: { id: string }) => t.id)).toEqual(['c']);
    expect(filterTasks(tasks, 'nothing like it')).toEqual([]);
  });
  it('status labels', () => {
    expect(statusLabel('review')).toEqual(['ready', 'green']);
    expect(statusLabel('weird')).toEqual(['weird', 'grey']);
  });
});
