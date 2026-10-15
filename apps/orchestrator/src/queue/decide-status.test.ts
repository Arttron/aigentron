import { describe, expect, it } from 'vitest';
import type { AgentRunOutcome } from '../agent/agent-executor';
import { decideStatus, type RunDecision, type RunDecisionContext } from './decide-status';

const base: AgentRunOutcome = { reported: null, errored: false, timedOut: false };
const code: RunDecisionContext = { chat: false, parentId: null, requireStatusReport: false };
const chat: RunDecisionContext = { ...code, chat: true };

/** The contract as a table: (what the run produced, who ran it) → what happens to the task. */
const table: [string, Partial<AgentRunOutcome>, RunDecisionContext, RunDecision][] = [
  ['done → review', { reported: 'done' }, code, { kind: 'finish', status: 'review' }],
  ['done, subtask → done', { reported: 'done' }, { ...code, parentId: 'P' }, { kind: 'finish', status: 'done' }],
  ['done then an error → still a clean finish', { reported: 'done', errored: true, timedOut: true }, code, { kind: 'finish', status: 'review' }],
  ['blocked with summary', { reported: 'blocked', reportedSummary: 'need creds' }, code, { kind: 'settle', status: 'blocked', error: 'need creds' }],
  ['blocked without summary', { reported: 'blocked' }, code, { kind: 'settle', status: 'blocked', error: 'agent reported blocked' }],
  ['failed with summary', { reported: 'failed', reportedSummary: 'tests red' }, code, { kind: 'settle', status: 'failed', error: 'tests red' }],
  ['failed without summary', { reported: 'failed' }, code, { kind: 'settle', status: 'failed', error: 'agent reported failure' }],
  ['out of steps, no report → continuation', { maxTurns: true, errored: true }, code, { kind: 'continuation' }],
  ['out of steps but reported done → finish', { maxTurns: true, reported: 'done' }, code, { kind: 'finish', status: 'review' }],
  ['timed out → stalled', { errored: true, timedOut: true }, code, { kind: 'settle', status: 'stalled', error: 'run timed out without a status report' }],
  ['crashed, last message → stalled with it', { errored: true, finalText: 'Which DB?' }, code, { kind: 'settle', status: 'stalled', error: "run ended abnormally without a status report — agent's last message:\nWhich DB?" }],
  ['no report, lenient → review', {}, code, { kind: 'finish', status: 'review' }],
  ['no report, strict → stalled', {}, { ...code, requireStatusReport: true }, { kind: 'settle', status: 'stalled', error: 'run finished without calling report_task_status' }],
  ['no report, strict, last message → stalled with it', { finalText: 'ok?' }, { ...code, requireStatusReport: true }, { kind: 'settle', status: 'stalled', error: "run finished without calling report_task_status — agent's last message:\nok?" }],
  // chat agents
  ['chat: done → review', { reported: 'done' }, chat, { kind: 'finish', status: 'review' }],
  ['chat: no report → review (no strict mode for a turn)', {}, { ...chat, requireStatusReport: true }, { kind: 'finish', status: 'review' }],
  ['chat: subtask → done', {}, { ...chat, parentId: 'P' }, { kind: 'finish', status: 'done' }],
  ['chat: timed out → failed', { errored: true, timedOut: true }, chat, { kind: 'settle', status: 'failed', error: 'chat turn timed out' }],
  ['chat: errored with message → failed with it (clipped)', { errored: true, finalText: 'x'.repeat(600) }, chat, { kind: 'settle', status: 'failed', error: 'x'.repeat(500) }],
  ['chat: errored, no message → failed', { errored: true }, chat, { kind: 'settle', status: 'failed', error: 'chat turn failed' }],
  ['chat: blocked (e.g. budget) → blocked', { reported: 'blocked', reportedSummary: 'budget' }, chat, { kind: 'settle', status: 'blocked', error: 'budget' }],
  ['chat: failed report → failed', { reported: 'failed', reportedSummary: 'nope' }, chat, { kind: 'settle', status: 'failed', error: 'nope' }],
  ['chat: out of steps → just a finish (no continuation prompts for a turn)', { maxTurns: true }, chat, { kind: 'finish', status: 'review' }],
];

describe('decideStatus', () => {
  for (const [name, outcome, ctx, expected] of table) {
    it(name, () => {
      expect(decideStatus({ ...base, ...outcome }, ctx)).toEqual(expected);
    });
  }

  it('a provider failure keeps its own error text as the reason (not a generic "ended abnormally")', () => {
    const d = decideStatus({ reported: null, errored: true, timedOut: false, errorText: 'rate limit exceeded' } as never, { chat: false, parentId: null, requireStatusReport: true });
    expect(d).toMatchObject({ kind: 'settle', status: 'stalled' });
    expect((d as { error: string }).error).toContain('the provider failed: rate limit exceeded');
  });
});
