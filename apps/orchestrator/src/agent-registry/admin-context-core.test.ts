import { describe, expect, it } from 'vitest';
import { parsePage, sanitizePage } from './admin-context-core';

describe('parsePage', () => {
  it('finds the task and the project of a page', () => {
    expect(parsePage('/tasks/abc123')).toMatchObject({ kind: 'task', id: 'abc123' });
    expect(parsePage('/tasks/abc123?x=1')).toMatchObject({ kind: 'task', id: 'abc123' });
    expect(parsePage('/projects/web')).toMatchObject({ kind: 'project', id: 'web' });
  });
  it('names the other pages and tolerates unknown ones', () => {
    expect(parsePage('/').name).toContain('task list');
    expect(parsePage('/settings').name).toContain('Settings');
    expect(parsePage('/projects').kind).toBe('page');
    expect(parsePage('/weird/path').name).toContain('/weird/path');
  });
});

describe('sanitizePage', () => {
  it('accepts only a plain dashboard path', () => {
    expect(sanitizePage({ path: '/tasks/1', title: 'T' })).toEqual({ path: '/tasks/1', title: 'T' });
    expect(sanitizePage({ path: 'https://evil' })).toBeNull();
    expect(sanitizePage({ path: '/' + 'a'.repeat(400) })).toBeNull();
    expect(sanitizePage(null)).toBeNull();
  });
});
