import { describe, expect, it, vi } from 'vitest';
import { ChannelGateway } from './channel-gateway.service';

function make() {
  const linkMessage = vi.fn(async () => undefined);
  const gateway = new ChannelGateway({ linkMessage } as never);
  let n = 0;
  const sendMessage = vi.fn(async () => ({ messageId: String(++n) }));
  gateway.adapters.set('c1', { kind: 'test', maxTextLength: 100, sendMessage, stop: async () => undefined } as never);
  return { gateway, sendMessage, linkMessage };
}

describe('ChannelGateway.send', () => {
  it('a short text is one message with its buttons, linked to the task with what it stands for', async () => {
    const { gateway, sendMessage, linkMessage } = make();
    const buttons = [[{ label: 'ok', data: 'x' }]];
    const sent = await gateway.send('c1', '42', 'hello', buttons, 't1', { kind: 'question', refId: 'q1' });
    expect(sent).toEqual({ messageId: '1' });
    expect(sendMessage).toHaveBeenCalledWith('42', 'hello', buttons);
    expect(linkMessage).toHaveBeenCalledWith('c1', '42', '1', 't1', { kind: 'question', refId: 'q1' });
  });

  it("a long text is split at the adapter's limit: every piece is linked to the task, the buttons go on the last one (C-03)", async () => {
    const { gateway, sendMessage, linkMessage } = make();
    const text = Array.from({ length: 12 }, (_, i) => `paragraph ${i} ${'x'.repeat(30)}`).join('\n\n');
    const buttons = [[{ label: 'ok', data: 'x' }]];
    const sent = await gateway.send('c1', '42', text, buttons, 't1', { kind: 'approval', refId: 'a1' });
    expect(sendMessage.mock.calls.length).toBeGreaterThan(1);
    const calls = sendMessage.mock.calls as unknown as [string, string, unknown][];
    for (const [, piece] of calls) expect(piece.length).toBeLessThanOrEqual(100);
    for (const [, , b] of calls.slice(0, -1)) expect(b).toBeUndefined();
    const last = sendMessage.mock.calls[sendMessage.mock.calls.length - 1]! as unknown as [string, string, unknown];
    expect(last[2]).toBe(buttons);
    expect(sent!.messageId).toBe(String(sendMessage.mock.calls.length));
    expect(linkMessage).toHaveBeenCalledTimes(sendMessage.mock.calls.length);
    expect(linkMessage.mock.calls.filter((c) => (c as unknown[])[4] !== undefined)).toHaveLength(1);
    expect(linkMessage.mock.calls[linkMessage.mock.calls.length - 1]).toEqual(['c1', '42', sent!.messageId, 't1', { kind: 'approval', refId: 'a1' }]);
  });

  it('a channel that is switched off (no running adapter) stays silent: nothing is sent, nothing is built (C-12)', async () => {
    const { gateway, sendMessage } = make();
    expect(await gateway.send('off', '42', 'hello')).toBeNull();
    expect(await gateway.sendText('off', '42', 'hello')).toBe(false);
    expect(gateway.adapterFor('off')).toBeNull();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('a transport error is swallowed and reported as "not sent"', async () => {
    const { gateway, sendMessage } = make();
    sendMessage.mockRejectedValueOnce(new Error('boom'));
    expect(await gateway.send('c1', '42', 'hello')).toBeNull();
  });
});
