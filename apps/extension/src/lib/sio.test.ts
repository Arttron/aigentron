import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JS module of the extension
import { SioClient, backoffMs, encodeConnect, encodeEvent, parsePacket, socketUrl } from './sio.js';
// @ts-expect-error plain JS module of the extension
import { buildCard, injectable, notificationText, orderItems, shouldPlaySound } from './cards.js';

describe('socket.io packets', () => {
  it('parses what the server sends', () => {
    expect(parsePacket('0{"sid":"x","pingInterval":25000}')).toEqual({ type: 'open', data: { sid: 'x', pingInterval: 25000 } });
    expect(parsePacket('2')).toEqual({ type: 'ping' });
    expect(parsePacket('40{"sid":"abc"}')).toEqual({ type: 'connect', data: { sid: 'abc' } });
    expect(parsePacket('42["approval:created",{"approval":{"id":"a1"}}]')).toEqual({ type: 'event', name: 'approval:created', args: [{ approval: { id: 'a1' } }] });
    expect(parsePacket('44{"message":"no"}')).toEqual({ type: 'error', data: { message: 'no' } });
    expect(parsePacket('41')).toEqual({ type: 'disconnect' });
    for (const junk of ['', 'x', '5', '42notjson', '42{"a":1}', null, 7]) expect(parsePacket(junk as never)).toBeNull();
  });
  it('encodes what the client sends', () => {
    expect(encodeConnect({ token: 't' })).toBe('40{"token":"t"}');
    expect(encodeEvent('client:focus')).toBe('42["client:focus"]');
    expect(socketUrl('https://a.example.com')).toBe('wss://a.example.com/socket.io/?EIO=4&transport=websocket');
    expect(socketUrl('http://localhost:3011')).toBe('ws://localhost:3011/socket.io/?EIO=4&transport=websocket');
    expect([0, 1, 2, 3, 4, 9].map(backoffMs)).toEqual([1000, 2000, 5000, 10000, 30000, 30000]);
  });
  it('a client: handshake, auth in the connect packet, pong, events, emit only when connected', () => {
    const sent: string[] = [];
    const events: [string, unknown[]][] = [];
    const states: string[] = [];
    class FakeWS {
      static last: FakeWS;
      readyState = 1;
      onmessage: ((e: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(public url: string) { FakeWS.last = this; }
      send(s: string) { sent.push(s); }
      close() { this.onclose?.(); }
    }
    const c = new SioClient({ url: 'ws://x', auth: { token: 'ext_1' }, onEvent: (n: string, a: unknown[]) => events.push([n, a]), onState: (s: string) => states.push(s), WebSocketImpl: FakeWS });
    c.start();
    c.emit('client:focus'); // not connected yet: dropped
    expect(sent).toEqual([]);
    FakeWS.last.onmessage!({ data: '0{"sid":"s"}' });
    expect(sent).toEqual(['40{"token":"ext_1"}']);
    FakeWS.last.onmessage!({ data: '40{"sid":"s"}' });
    expect(states).toEqual(['connecting', 'open']);
    FakeWS.last.onmessage!({ data: '2' });
    c.emit('client:focus');
    FakeWS.last.onmessage!({ data: '42["question:created",{"question":{"id":"q"}}]' });
    expect(sent).toEqual(['40{"token":"ext_1"}', '3', '42["client:focus"]']);
    expect(events).toEqual([['question:created', [{ question: { id: 'q' } }]]]);
    c.stop();
  });
});

describe('cards', () => {
  const a = (extra = {}) => ({ id: 'a1', taskId: 't1', toolName: 'Bash', summary: '$ npm test', reason: 'recursive force remove (rm -rf)', createdAt: '2026-01-02', ...extra });
  it('an approval card names the task and carries the dashboard-only flag', () => {
    const c = buildCard({ kind: 'approval', data: a({ needsDashboard: true }) }, { project: 'Main', title: 'Fix login' });
    expect(c).toMatchObject({ kind: 'approval', id: 'a1', where: 'Main · Fix login', tool: 'Bash', needsDashboard: true });
    expect(buildCard({ kind: 'approval', data: a({ toolName: 'mcp__lds_internal__push_branch' }) }).tool).toBe('push_branch');
    expect(buildCard({ kind: 'approval', data: a({ summary: 'x'.repeat(2000) }) }).summary.length).toBe(800);
  });
  it('a question card offers its options, and a text field when allowed or when there are no options', () => {
    const q = (extra = {}) => ({ id: 'q1', taskId: 't1', question: 'Which one?', options: ['A', 'B'], allowText: false, multiple: false, createdAt: '2026-01-01', ...extra });
    expect(buildCard({ kind: 'question', data: q() })).toMatchObject({ options: ['A', 'B'], allowText: false, multiple: false });
    expect(buildCard({ kind: 'question', data: q({ allowText: true }) }).allowText).toBe(true);
    expect(buildCard({ kind: 'question', data: q({ options: [] }) }).allowText).toBe(true);
  });
  it('the oldest request comes first', () => {
    const order = orderItems([a({ id: 'late', createdAt: '2026-01-03' })], [{ id: 'q', createdAt: '2026-01-01' }]);
    expect(order.map((i: { data: { id: string } }) => i.data.id)).toEqual(['q', 'late']);
  });
  it('notification text, and where a card can be drawn', () => {
    expect(notificationText(buildCard({ kind: 'approval', data: a() }, { project: 'P', title: 'T' }))).toEqual({ title: 'An agent needs your approval', message: 'P · T\n$ npm test' });
    expect(injectable('https://example.com/x')).toBe(true);
    for (const u of ['chrome://settings', 'about:blank', 'file:///x', 'chrome-extension://x/a.html', 'https://chromewebstore.google.com/detail/x', undefined]) expect(injectable(u as never), String(u)).toBe(false);
  });
});

describe('the sound', () => {
  it('is not played while a dashboard tab is open (the dashboard has its own), nor when switched off', () => {
    expect(shouldPlaySound({ sound: true }, 0)).toBe(true);
    expect(shouldPlaySound({ sound: true }, 1)).toBe(false);
    expect(shouldPlaySound({ sound: true }, 3)).toBe(false);
    expect(shouldPlaySound({ sound: false }, 0)).toBe(false);
    expect(shouldPlaySound(undefined, 0)).toBe(false);
  });
});
