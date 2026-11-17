import { describe, expect, it } from 'vitest';
import { messageLink, parseMessageLink } from './message-link';

describe('message links', () => {
  it('a built link is read back', () => {
    expect(parseMessageLink(messageLink('task1', 'sess9', 42))).toEqual({ taskId: 'task1', sessionId: 'sess9', seq: 42 });
  });
  it('reads a full URL, also inside a sentence, with other parameters around', () => {
    const url = `http://localhost:3000${messageLink('cabc123', 'cxyz789', 7)}`;
    expect(parseMessageLink(`look at ${url}, please`)).toEqual({ taskId: 'cabc123', sessionId: 'cxyz789', seq: 7 });
    expect(parseMessageLink('https://h/tasks/t1?x=1&ev=s1%3A3')).toEqual({ taskId: 't1', sessionId: 's1', seq: 3 });
    expect(parseMessageLink('[answer](https://h/tasks/t1?ev=s1:3)')).toEqual({ taskId: 't1', sessionId: 's1', seq: 3 });
  });
  it('refuses what is not a message link', () => {
    expect(parseMessageLink('')).toBeNull();
    expect(parseMessageLink('https://h/tasks/t1')).toBeNull();
    expect(parseMessageLink('https://h/tasks/t1?ev=pending-123')).toBeNull();
    expect(parseMessageLink('https://h/tasks/t1?ev=s1:abc')).toBeNull();
    expect(parseMessageLink('https://h/tasks/t1?ev=%E0%A4%A')).toBeNull();
  });
});
