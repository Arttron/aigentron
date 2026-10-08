import { describe, expect, it, vi } from 'vitest';
import { buildInternalToolSpecs } from './internal-tools';

describe('buildInternalToolSpecs', () => {
  it('only exposes tools that are wired', () => {
    expect(buildInternalToolSpecs({})).toEqual([]);
    const names = buildInternalToolSpecs({ onReportStatus: () => {}, onHeartbeat: () => {} }).map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(['report_task_status', 'heartbeat']));
    expect(names).not.toContain('create_subtask');
  });
  it('report_task_status forwards the report to the callback', async () => {
    const cb = vi.fn();
    const spec = buildInternalToolSpecs({ onReportStatus: cb }).find((s) => s.name === 'report_task_status')!;
    await spec.handler({ status: 'done', summary: 's' });
    expect(cb).toHaveBeenCalledWith({ status: 'done', summary: 's' });
  });
});
