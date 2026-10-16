import { describe, expect, it } from 'vitest';
import { readFilterParam, withFilterParam } from './url-filter';

const isColor = (v: string | null): v is 'red' | 'blue' => v === 'red' || v === 'blue';

describe('readFilterParam', () => {
  it('returns a known value', () => expect(readFilterParam('?type=red&x=1', 'type', isColor)).toBe('red'));
  it('ignores unknown or missing values', () => {
    expect(readFilterParam('?type=green', 'type', isColor)).toBeNull();
    expect(readFilterParam('', 'type', isColor)).toBeNull();
  });
});

describe('withFilterParam', () => {
  it('sets the param and keeps the rest', () => {
    expect(withFilterParam('http://h/tasks?q=a#top', 'status', 'done').href).toBe('http://h/tasks?q=a&status=done#top');
  });
  it('replaces an existing value', () => {
    expect(withFilterParam('http://h/?status=done', 'status', 'failed').search).toBe('?status=failed');
  });
  it('removes the param for an empty value', () => {
    expect(withFilterParam('http://h/?status=done&q=a', 'status', '').search).toBe('?q=a');
  });
});
