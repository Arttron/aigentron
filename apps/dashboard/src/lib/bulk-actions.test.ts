import { describe, expect, it } from 'vitest';
import { appliesTo, listStatus, planBulk, rangeIds, runBulk } from './bulk-actions';

describe('bulk actions', () => {
  it('delete is for everything, cancel only for live tasks, done only for settled ones that wait for a person', () => {
    expect(['queued', 'done', 'failed'].every((s) => appliesTo('delete', s))).toBe(true);
    expect(['queued', 'running', 'needs_approval'].every((s) => appliesTo('cancel', s))).toBe(true);
    expect(['review', 'done', 'cancelled', 'failed'].some((s) => appliesTo('cancel', s))).toBe(false);
    expect(['review', 'blocked', 'stalled', 'failed'].every((s) => appliesTo('done', s))).toBe(true);
    expect(['running', 'queued', 'done', 'cancelled'].some((s) => appliesTo('done', s))).toBe(false);
  });
  it('planBulk lists the tasks the action touches and counts the skipped ones', () => {
    const t = [{ id: 'a', status: 'running' }, { id: 'b', status: 'review' }, { id: 'c', status: 'done' }];
    expect(planBulk('cancel', t)).toEqual({ ids: ['a'], skipped: 2 });
    expect(planBulk('done', t)).toEqual({ ids: ['b'], skipped: 2 });
    expect(planBulk('delete', t)).toEqual({ ids: ['a', 'b', 'c'], skipped: 0 });
  });
  it('runBulk goes through every id, counts failures and keeps going', async () => {
    const seen: string[] = [];
    const r = await runBulk(['1', '2', '3', '4', '5'], async (id) => {
      seen.push(id);
      if (id === '2' || id === '4') throw new Error(`no ${id}`);
    });
    expect(r.ok).toBe(3);
    expect(r.failed).toBe(2);
    expect(r.errors.sort()).toEqual(['no 2', 'no 4']);
    expect(seen.sort()).toEqual(['1', '2', '3', '4', '5']);
    expect(await runBulk([], async () => undefined)).toEqual({ ok: 0, failed: 0, errors: [] });
  });
});

describe('listStatus — what the task list shows', () => {
  const kids = { byStatus: { running: 1, done: 3 } };
  it('an idle lead with a running subtask is running', () => {
    for (const status of ['queued', 'review', 'stalled']) expect(listStatus({ status, subtasks: kids })).toBe('running');
  });
  it('a task that waits for a person, or is settled, keeps its own status', () => {
    for (const status of ['needs_approval', 'blocked', 'done', 'failed', 'cancelled', 'running']) expect(listStatus({ status, subtasks: kids })).toBe(status);
  });
  it('no running subtask: its own status', () => {
    expect(listStatus({ status: 'review', subtasks: { byStatus: { done: 2, queued: 1 } } })).toBe('review');
    expect(listStatus({ status: 'review' })).toBe('review');
  });
});

describe('rangeIds — shift-click selects everything between two rows', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  it('from an earlier row down, and from a later row up (inclusive)', () => {
    expect(rangeIds(ids, 'b', 'd')).toEqual(['b', 'c', 'd']);
    expect(rangeIds(ids, 'd', 'b')).toEqual(['b', 'c', 'd']);
    expect(rangeIds(ids, 'c', 'c')).toEqual(['c']);
  });
  it('no earlier click, or one that is not on this page: just the clicked row', () => {
    expect(rangeIds(ids, null, 'c')).toEqual(['c']);
    expect(rangeIds(ids, 'zzz', 'c')).toEqual(['c']);
  });
  it('a clicked row that is not in the list gives nothing', () => {
    expect(rangeIds(ids, 'a', 'zzz')).toEqual([]);
  });
});
