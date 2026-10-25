import { describe, expect, it } from 'vitest';
import { chatTargets } from './project-chats';

const a = { channelId: 'tg', chatId: 'A' };
const b = { channelId: 'tg', chatId: 'B' };
const c = { channelId: 'tg', chatId: 'C' };
const all = [a, b, c];

describe('chatTargets', () => {
  it('no project owns a chat: everybody hears everything, as before', () => {
    expect(chatTargets('p1', all, [])).toEqual(all);
  });
  it("a project with its own chat is announced there only", () => {
    expect(chatTargets('p1', all, [{ projectId: 'p1', ...b }])).toEqual([b]);
  });
  it("a project without a chat skips the chats other projects own", () => {
    expect(chatTargets('p2', all, [{ projectId: 'p1', ...b }, { projectId: 'p3', ...c }])).toEqual([a]);
  });
  it("a chat the channel does not allow is never a target", () => {
    expect(chatTargets('p1', [a], [{ projectId: 'p1', ...b }])).toEqual([]);
  });
  it('a chat shared by two projects serves both', () => {
    const shared = [{ projectId: 'p1', ...b }, { projectId: 'p2', ...b }];
    expect(chatTargets('p1', all, shared)).toEqual([b]);
    expect(chatTargets('p2', all, shared)).toEqual([b]);
    expect(chatTargets('p9', all, shared)).toEqual([a, c]);
  });
});
