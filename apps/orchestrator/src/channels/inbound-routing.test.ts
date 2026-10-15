import { describe, expect, it } from 'vitest';
import { resolveTarget, spokenToTask, type RouteTarget, type RoutingFacts } from './inbound-routing';

const active = { id: 'A', agentName: 'pm' };
const q = { id: 'Q', taskId: 'A' };

/** The order of precedence, as a table: [name, facts, expected]. */
const table: [string, RoutingFacts, RouteTarget][] = [
  ['nothing known → new task', {}, { kind: 'new' }],
  ['active task → follow-up', { activeTask: active }, { kind: 'follow-up', taskId: 'A', switchTo: false }],
  ['active task gone (null) → new task', { activeTask: null }, { kind: 'new' }],
  ['quoted message of another task → follow-up to it and switch', { activeTask: active, quotedTaskId: 'B' }, { kind: 'follow-up', taskId: 'B', switchTo: true }],
  ['quoted message of the active task → follow-up, no switch', { activeTask: active, quotedTaskId: 'A' }, { kind: 'follow-up', taskId: 'A', switchTo: false }],
  ['quoted message, no active task → follow-up and switch', { quotedTaskId: 'B' }, { kind: 'follow-up', taskId: 'B', switchTo: true }],
  ['open question of the active task → the text is the answer', { activeTask: active, openQuestion: q }, { kind: 'answer', questionId: 'Q', taskId: 'A' }],
  ['open question beats the quote', { activeTask: active, quotedTaskId: 'B', openQuestion: { id: 'Q2', taskId: 'B' } }, { kind: 'answer', questionId: 'Q2', taskId: 'B' }],
  ['a command beats question, quote and active task', { command: true, activeTask: active, quotedTaskId: 'B', openQuestion: q }, { kind: 'command' }],
  ['`/pm text` with pm\'s task active → follow-up to it', { address: { agent: 'pm', rest: 'go on' }, activeTask: active, quotedTaskId: 'B', openQuestion: q }, { kind: 'follow-up', taskId: 'A', switchTo: false }],
  ['`/dev text` while pm\'s task is active → new task for dev', { address: { agent: 'dev', rest: 'fix it' }, activeTask: active }, { kind: 'new', agent: 'dev' }],
  ['`/dev text` with no active task → new task for dev', { address: { agent: 'dev', rest: 'fix it' } }, { kind: 'new', agent: 'dev' }],
  ['just `/dev` → talk to dev from now on (even with an open question)', { address: { agent: 'dev', rest: '' }, activeTask: active, openQuestion: q }, { kind: 'select-agent', agent: 'dev' }],
  ['address beats a command flag', { address: { agent: 'pm', rest: 'x' }, command: true }, { kind: 'new', agent: 'pm' }],
];

describe('resolveTarget — precedence table', () => {
  it.each(table)('%s', (_name, facts, expected) => {
    expect(resolveTarget(facts)).toEqual(expected);
  });

  it('a file (no question considered) follows the same quote → active → new order', () => {
    expect(resolveTarget({ activeTask: active })).toEqual({ kind: 'follow-up', taskId: 'A', switchTo: false });
    expect(resolveTarget({ activeTask: active, quotedTaskId: 'B' })).toEqual({ kind: 'follow-up', taskId: 'B', switchTo: true });
    expect(resolveTarget({})).toEqual({ kind: 'new' });
  });

  it('spokenToTask: the quoted task, else the active one', () => {
    expect(spokenToTask({ quotedTaskId: 'B', activeTask: active })).toBe('B');
    expect(spokenToTask({ activeTask: active })).toBe('A');
    expect(spokenToTask({})).toBeNull();
  });
});
