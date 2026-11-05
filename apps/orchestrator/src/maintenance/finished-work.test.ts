import { describe, expect, it } from 'vitest';
import { decideCleanup, type CheckoutFacts, type CleanupPolicy } from './finished-work';

const DAY = 86_400_000;
const now = Date.parse('2026-11-10T12:00:00Z');
const policy: CleanupPolicy = { mode: 'merged_or_done', doneDays: 3 };
const facts = (o: Partial<CheckoutFacts> = {}): CheckoutFacts => ({ status: 'done', finishedAt: now - 5 * DAY, awaitingSubtasks: false, dirty: false, ahead: 2, pushed: false, appliedByPatch: false, prMerged: null, ...o });

describe('decideCleanup: never lose work', () => {
  it('is off when switched off', () => expect(decideCleanup({ ...policy, mode: 'off' }, facts({ ahead: 0 }), now).remove).toBe(false));
  it('never touches a task that is being worked on, or a lead waiting for subtasks', () => {
    for (const status of ['queued', 'running', 'needs_approval']) expect(decideCleanup(policy, facts({ status, ahead: 0 }), now).remove).toBe(false);
    expect(decideCleanup(policy, facts({ awaitingSubtasks: true, ahead: 0 }), now).remove).toBe(false);
  });
  it('keeps a checkout with uncommitted or unchecked files, even when the work is merged', () => {
    expect(decideCleanup(policy, facts({ dirty: true, ahead: 0 }), now)).toMatchObject({ remove: false, reason: expect.stringContaining('uncommitted') });
    expect(decideCleanup(policy, facts({ dirty: null, ahead: 0 }), now).remove).toBe(false);
  });
  it('keeps commits that exist only here: not merged and not pushed', () => {
    const d = decideCleanup(policy, facts({ ahead: 3, pushed: false }), now);
    expect(d.remove).toBe(false);
    expect(d.reason).toContain('3 commit(s) exist only here');
  });
  it('does not guess when it could not tell', () => {
    expect(decideCleanup(policy, facts({ ahead: null }), now).remove).toBe(false);
    expect(decideCleanup(policy, facts({ pushed: null }), now).remove).toBe(false);
  });
});

describe('decideCleanup: when work is merged', () => {
  it('removes the checkout and the branch as soon as everything on the branch is in the base', () => {
    expect(decideCleanup(policy, facts({ ahead: 0, status: 'review', finishedAt: now }), now)).toMatchObject({ remove: true, deleteBranch: true });
  });
  it('a rebase merge (same changes as other commits) and a merged pull request count too', () => {
    expect(decideCleanup(policy, facts({ ahead: 4, appliedByPatch: true, status: 'review' }), now)).toMatchObject({ remove: true, deleteBranch: true });
    expect(decideCleanup(policy, facts({ ahead: 4, prMerged: true, status: 'stalled' }), now)).toMatchObject({ remove: true, deleteBranch: true, reason: expect.stringContaining('pull request') });
  });
  it('the mode "merged" waits for the merge and does nothing for finished-but-unmerged work', () => {
    const d = decideCleanup({ ...policy, mode: 'merged' }, facts({ ahead: 2, pushed: true }), now);
    expect(d).toMatchObject({ remove: false, reason: expect.stringContaining('not merged') });
  });
});

describe('decideCleanup: finished work that is not merged', () => {
  it('waits the grace period after the task finished', () => {
    const d = decideCleanup(policy, facts({ pushed: true, finishedAt: now - 1 * DAY }), now);
    expect(d.remove).toBe(false);
    expect(d.reason).toContain('3 day(s)');
  });
  it('after the grace period, with its commits on the remote: the checkout goes, the branch stays', () => {
    expect(decideCleanup(policy, facts({ pushed: true, finishedAt: now - 4 * DAY }), now)).toMatchObject({ remove: true, deleteBranch: false });
  });
  it('only done / cancelled tasks: a task that failed, stalled or waits for review keeps its checkout (a person may continue it)', () => {
    for (const status of ['failed', 'stalled', 'blocked', 'review']) expect(decideCleanup(policy, facts({ status, pushed: true }), now).remove).toBe(false);
    expect(decideCleanup(policy, facts({ status: 'cancelled', pushed: true }), now).remove).toBe(true);
  });
});
