import { describe, expect, it } from 'vitest';
import { CREATE_TASK_TOOL, EXTEND_RUN_TOOL, INTERNAL_TOOL_PREFIX, PROPOSE_SETTINGS_TOOL, PUSH_BRANCH_TOOL } from '@lds/shared';
import { approvalWaived, parseApprovalMode, resolveApprovalMode } from './approval-mode';

const risky = { dangerous: true };

describe('approval mode', () => {
  it('only the word off switches approvals off', () => {
    expect(parseApprovalMode('off')).toBe('off');
    for (const v of ['ask', '', undefined, null, 'OFF', true]) expect(parseApprovalMode(v)).toBe('ask');
  });
  it('ask mode waives nothing', () => {
    expect(approvalWaived('ask', 'Bash', risky)).toBe(false);
  });
  it('off mode waives the agent’s own risky actions', () => {
    expect(approvalWaived('off', 'Bash', risky)).toBe(true);
    expect(approvalWaived('off', 'Write', risky)).toBe(true);
    expect(approvalWaived('off', 'mcp__github__create_issue', risky)).toBe(true);
    expect(approvalWaived('off', PUSH_BRANCH_TOOL, risky)).toBe(true);
    expect(approvalWaived('off', CREATE_TASK_TOOL, risky)).toBe(true);
    expect(approvalWaived('off', EXTEND_RUN_TOOL, risky)).toBe(true); // more run time is granted by itself: the person chose not to be asked
  });
  it('off mode still asks about a merge, an action on main / master and anything outside the working directory', () => {
    for (const guard of ['merge', 'main-branch', 'outside'] as const) {
      expect(approvalWaived('off', 'Bash', { dangerous: true, guard })).toBe(false);
      expect(approvalWaived('off', PUSH_BRANCH_TOOL, { dangerous: true, guard })).toBe(false);
      expect(approvalWaived('off', 'mcp__github__merge_pull_request', { dangerous: true, guard })).toBe(false);
    }
  });
  it('off mode never waives credentials / protected files or admin proposals', () => {
    expect(approvalWaived('off', 'Bash', { dangerous: true, hard: true })).toBe(false);
    expect(approvalWaived('off', PROPOSE_SETTINGS_TOOL, risky)).toBe(false);
    expect(approvalWaived('off', `${INTERNAL_TOOL_PREFIX}request_secret`, risky)).toBe(false);
    expect(approvalWaived('off', `${INTERNAL_TOOL_PREFIX}propose_learned_skill`, risky)).toBe(false);
  });
});

describe('approval mode levels', () => {
  it('nothing set anywhere: ask', () => {
    expect(resolveApprovalMode({})).toEqual({ mode: 'ask', source: 'default' });
  });
  it('the global setting applies when nothing is set below it', () => {
    expect(resolveApprovalMode({ global: 'off' })).toEqual({ mode: 'off', source: 'global' });
  });
  it('a project overrides the global setting, in both directions', () => {
    expect(resolveApprovalMode({ project: 'off', global: 'ask' })).toEqual({ mode: 'off', source: 'project' });
    expect(resolveApprovalMode({ project: 'ask', global: 'off' })).toEqual({ mode: 'ask', source: 'project' });
  });
  it('a task overrides its project; a subtask follows the nearest lead that is set', () => {
    expect(resolveApprovalMode({ task: 'off', project: 'ask' })).toEqual({ mode: 'off', source: 'task' });
    expect(resolveApprovalMode({ ancestors: [null, 'off', 'ask'], project: 'ask' })).toEqual({ mode: 'off', source: 'ancestor' });
    expect(resolveApprovalMode({ task: 'ask', ancestors: ['off'] })).toEqual({ mode: 'ask', source: 'task' });
  });
  it('junk values mean "not set"', () => {
    expect(resolveApprovalMode({ task: 'maybe', project: '', global: 7 })).toEqual({ mode: 'ask', source: 'default' });
  });
});
