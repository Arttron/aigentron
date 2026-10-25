import { describe, expect, it } from 'vitest';
import { ESCALATION_TAIL_MARK, FAN_IN_TAIL_MARK, splitSubtaskReport, subtaskBlock } from './subtask-report';

const fanIn = (blocks: string[], after = '') =>
  `All ${blocks.length} subtasks you created have finished:\n\n${blocks.join('\n\n')}\n\n${FAN_IN_TAIL_MARK} — integrate them, start the next phase, or report the task done. Write your own result.${after}`;

describe('splitSubtaskReport', () => {
  it('one block per subtask, the instructions dropped', () => {
    const p = fanIn([subtaskBlock({ id: 'cmabc123', title: 'Design', status: 'done', body: 'Palette: sage.\nSecond line' }), subtaskBlock({ id: 'cmdef456', title: 'Estimate', status: 'failed', body: 'no data' })]);
    const r = splitSubtaskReport(p)!;
    expect(r.reports).toEqual([
      { id: 'cmabc123', title: 'Design', status: 'done', text: 'Palette: sage.\nSecond line' },
      { id: 'cmdef456', title: 'Estimate', status: 'failed', text: 'no data' },
    ]);
    expect(r.rest).toBe('');
  });
  it('a later message of the person (queued behind it) stays theirs', () => {
    const p = fanIn([subtaskBlock({ id: 'cmabc123', title: 'A', status: 'done', body: 'x' })], '\n\nAlso make it shorter please');
    expect(splitSubtaskReport(p)!.rest).toBe('Also make it shorter please');
  });
  it('a blocked subtask that asks the lead for a decision', () => {
    const p = `A subtask you created is blocked and needs a decision before it can continue:\n\n${subtaskBlock({ id: 'cmabc123', title: 'Deploy', status: 'blocked', body: 'Which region?' })}\n\n${ESCALATION_TAIL_MARK} — answer with follow_up.`;
    expect(splitSubtaskReport(p)!.reports).toEqual([{ id: 'cmabc123', title: 'Deploy', status: 'blocked', text: 'Which region?' }]);
  });
  it('a result that itself contains ### headings is not cut up', () => {
    const p = fanIn([subtaskBlock({ id: 'cmabc123', title: 'A', status: 'done', body: '### Findings\n- one\n### Next\n- two' })]);
    const r = splitSubtaskReport(p)!;
    expect(r.reports).toHaveLength(1);
    expect(r.reports[0]!.text).toContain('### Next');
  });
  it('an ordinary message is not a report', () => {
    expect(splitSubtaskReport('please fix the build')).toBeNull();
    expect(splitSubtaskReport('### Title\ntext')).toBeNull();
  });
});
