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
  it('read_document and the workspace tools appear only when wired and forward their arguments', async () => {
    expect(buildInternalToolSpecs({}).map((s) => s.name)).not.toContain('read_document');
    const read = vi.fn(async () => 'text');
    const specs = buildInternalToolSpecs({ onReadDocument: read, workspace: { info: async () => 'i', files: async () => 'f', note: async () => 'n' } });
    const names = specs.map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(['read_document', 'workspace_info', 'workspace_files', 'workspace_note']));
    expect(names).not.toContain('workspace_save');
    await specs.find((s) => s.name === 'read_document')!.handler({ path: 'plan.md', from: 12000 });
    expect(read).toHaveBeenCalledWith({ path: 'plan.md', from: 12000 });
  });
});
