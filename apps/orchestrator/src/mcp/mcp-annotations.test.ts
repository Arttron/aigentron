import { describe, expect, it } from 'vitest';
import { effectiveReadOnly, readOnlyFromAnnotations, stripRegistryKeys } from './mcp-annotations';

describe('readOnlyFromAnnotations', () => {
  it('keeps only explicit readOnlyHint tools, drops destructive and unannotated', () => {
    const tools = [
      { name: 'search', annotations: { readOnlyHint: true } },
      { name: 'weird', annotations: { readOnlyHint: true, destructiveHint: true } },
      { name: 'write', annotations: { readOnlyHint: false } },
      { name: 'plain' },
      { name: 'nul', annotations: null },
    ];
    expect(readOnlyFromAnnotations(tools)).toEqual(['search']);
  });
});

describe('effectiveReadOnly', () => {
  it('ignores discovered tools unless the server is trusted', () => {
    expect(effectiveReadOnly({ discoveredReadOnly: ['a'] })).toBeNull();
    expect(effectiveReadOnly({ trustAnnotations: false, discoveredReadOnly: ['a'] })).toBeNull();
  });
  it('merges declared + discovered when trusted', () => {
    expect(effectiveReadOnly({ readOnlyTools: ['x'], trustAnnotations: true, discoveredReadOnly: ['a', 'x'] })?.sort()).toEqual(['a', 'x']);
  });
  it('keeps the plain declaration working', () => {
    expect(effectiveReadOnly({ readOnlyTools: ['*'] })).toEqual(['*']);
  });
});

describe('stripRegistryKeys', () => {
  it('removes our keys, keeps runtime ones', () => {
    expect(stripRegistryKeys({ url: 'u', readOnlyTools: ['*'], trustAnnotations: true, discoveredReadOnly: [] })).toEqual({ url: 'u' });
  });
});
