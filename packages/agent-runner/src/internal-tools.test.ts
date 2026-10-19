import { describe, expect, it, vi } from 'vitest';
import * as shared from '@lds/shared';
import { INTERNAL_TOOL_PREFIX } from '@lds/shared';
import { buildInternalToolSpecs } from './internal-tools';
import { internalToolNames } from './run';

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

describe('internal tool registry', () => {
  // Every callback wired; `admin` is a Proxy so every admin handler exists.
  const noop = async () => '';
  const full = {
    onReportStatus: () => {}, onHeartbeat: () => {}, onCreateSubtask: noop, onCreateTask: noop, onCheckSubtasks: noop, onCompleteSubtask: noop,
    onScheduleCheck: noop, onSearchResources: noop, onShowImages: noop, onCurrentTime: noop, onReadDocument: noop,
    onAskUser: noop, onLookAt: noop, onVideoDigest: noop, onStartPreview: noop, onProposeLearnedSkill: noop,
    workspace: { info: noop, files: noop, note: noop, save: noop },
    kb: { list: noop, search: noop, read: noop, add: noop },
    admin: new Proxy({}, { get: () => noop }),
  } as unknown as Parameters<typeof buildInternalToolSpecs>[0];

  it('run.ts whitelist is derived from the specs (nothing built is missing)', () => {
    const specNames = buildInternalToolSpecs(full).map((s) => INTERNAL_TOOL_PREFIX + s.name);
    expect(internalToolNames(full)).toEqual(specNames);
    expect(new Set(specNames).size).toBe(specNames.length);
  });
  it('every spec name has a classify constant in @lds/shared, and vice versa', () => {
    const consts = new Set(
      Object.values(shared).filter((v): v is string => typeof v === 'string' && v.startsWith(INTERNAL_TOOL_PREFIX) && v !== INTERNAL_TOOL_PREFIX),
    );
    const specNames = new Set(buildInternalToolSpecs(full).map((s) => INTERNAL_TOOL_PREFIX + s.name));
    expect([...specNames].filter((n) => !consts.has(n))).toEqual([]);
    expect([...consts].filter((n) => !specNames.has(n))).toEqual([]);
  });
});
