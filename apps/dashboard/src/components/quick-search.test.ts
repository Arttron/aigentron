import { describe, expect, it } from 'vitest';
import { paletteRows } from './QuickSearch';

const task = (id: string, title: string, line: string) => ({ taskId: id, title, status: 'done', project: null, agent: null, updatedAt: '', hits: [{ eventId: 'e', line, kind: 'prompt', speaker: null, at: '', snippet: { text: 'hi there', marks: [[0, 2]] as [number, number][] } }] }) as never;

describe('paletteRows', () => {
  it('message hits first (opened at the message), then tasks found by title only', () => {
    const rows = paletteRows([task('a', 'A', 's:1')], [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }]);
    expect(rows.map((r) => r.key)).toEqual(['m:a', 't:b']);
    expect(rows[0]!.to).toBe('/tasks/a?ev=s%3A1');
    expect(rows[0]!.hit?.who).toBe('you');
    expect(rows[1]!.to).toBe('/tasks/b');
  });
  it('is cut to the limit', () => {
    expect(paletteRows([], Array.from({ length: 12 }, (_, i) => ({ id: String(i), title: 't' })), 5)).toHaveLength(5);
  });
});
