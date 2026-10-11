import { describe, expect, it } from 'vitest';
import { isStatusFilter, statusesOf } from './task-status-filter';

describe('status filter', () => {
  it('knows single statuses and the two groups', () => {
    expect(isStatusFilter('done')).toBe(true);
    expect(isStatusFilter('attention')).toBe(true);
    expect(isStatusFilter('nope')).toBe(false);
    expect(statusesOf('blocked')).toEqual(['blocked']);
    expect(statusesOf('active')).toEqual(['queued', 'running', 'needs_approval']);
    expect(statusesOf('attention')).toEqual(['needs_approval', 'blocked', 'stalled', 'failed']);
  });
});
