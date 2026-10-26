import { describe, expect, it, vi } from 'vitest';
import { ChannelManagerService } from './channel-manager.service';
import { ChannelGateway } from './channel-gateway.service';
import { adapterSignature, normalizeConfig } from './channels.service';

type Row = { id: string; name: string; kind: string; enabled: boolean; config: Record<string, unknown> };

function make(rows: Row[]) {
  const built: { row: Row; adapter: { startPolling: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> } }[] = [];
  const channels = {
    list: vi.fn(async () => rows.map((r) => ({ ...r }))), // a snapshot, like a query
    getRow: vi.fn(async (id: string) => rows.find((r) => r.id === id)),
    allowedChatIds: (r: Row) => (r.config.allowedChatIds as string[]) ?? [],
    isConfigured: (r: Row) => Boolean(r.config.botToken),
    buildAdapter: vi.fn((row: Row) => {
      const adapter = { kind: row.kind, startPolling: vi.fn(), stop: vi.fn(async () => undefined) };
      built.push({ row, adapter });
      return adapter;
    }),
    setRuntimeConfig: vi.fn(async () => undefined),
  };
  const gateway = new ChannelGateway(channels as never);
  const commands = { agentCommands: vi.fn(async () => []) };
  const svc = new ChannelManagerService({} as never, {} as never, channels as never, {} as never, {} as never, {} as never, {} as never, commands as never, {} as never, {} as never, {} as never, {} as never, gateway, {} as never);
  return { svc, gateway, channels, built, rows };
}

const row = (over: Partial<Row> = {}): Row => ({ id: 'c1', name: 'main', kind: 'telegram', enabled: true, config: { botToken: 'tok', allowedChatIds: ['42'] }, ...over });

describe('ChannelManagerService.reload — only what changed is restarted (C-05)', () => {
  it('starts enabled, configured channels; skips disabled and unconfigured ones', async () => {
    const { svc, gateway, built } = make([row(), row({ id: 'off', enabled: false }), row({ id: 'nokey', config: {} })]);
    await svc.reload();
    expect(built.map((b) => b.row.id)).toEqual(['c1']);
    expect(gateway.adapterFor('c1')).toBe(built[0]!.adapter);
    expect(gateway.adapterFor('off')).toBeNull();
    expect(built[0]!.adapter.startPolling).toHaveBeenCalledTimes(1);
  });

  it('a second reload with nothing changed leaves the running adapter alone (no stop, no rebuild)', async () => {
    const { svc, built, rows } = make([row()]);
    await svc.reload();
    rows[0]!.config = { ...rows[0]!.config, lastUpdateId: 123 }; // the runtime cursor moved — not a change
    await svc.reload();
    expect(built).toHaveLength(1);
    expect(built[0]!.adapter.stop).not.toHaveBeenCalled();
  });

  it('an edited channel (allow-list, token) is stopped and rebuilt; a removed one is stopped', async () => {
    const { svc, gateway, built, rows } = make([row(), row({ id: 'c2', name: 'second' })]);
    await svc.reload();
    rows[0]!.config = { ...rows[0]!.config, allowedChatIds: ['42', '43'] };
    rows.splice(1, 1);
    await svc.reload();
    expect(built[0]!.adapter.stop).toHaveBeenCalledTimes(1);
    expect(built[1]!.adapter.stop).toHaveBeenCalledTimes(1);
    expect(built).toHaveLength(3);
    expect(gateway.adapterFor('c1')).toBe(built[2]!.adapter);
    expect(gateway.adapterFor('c2')).toBeNull();
  });

  it('switching a channel off stops it and makes it silent', async () => {
    const { svc, gateway, built, rows } = make([row()]);
    await svc.reload();
    rows[0]!.enabled = false;
    await svc.reload();
    expect(built[0]!.adapter.stop).toHaveBeenCalledTimes(1);
    expect(gateway.adapterFor('c1')).toBeNull();
  });

  it('the inbound cursor handed over by the adapter is written to the channel config', async () => {
    const { svc, built, channels } = make([row()]);
    await svc.reload();
    const hooks = built[0]!.adapter.startPolling.mock.calls[0]![1] as { onOffset: (n: number) => void };
    hooks.onOffset(10);
    hooks.onOffset(11);
    await vi.waitFor(() => expect(channels.setRuntimeConfig).toHaveBeenCalledWith('c1', { lastUpdateId: 11 }));
  });
});

describe('channel config: the runtime cursor is kept across edits and ignored by the adapter signature', () => {
  const fields = [
    { key: 'botToken', label: 'Token', type: 'password' as const, secret: true, required: true },
    { key: 'allowedChatIds', label: 'Chats', type: 'list' as const },
  ];
  it('normalizeConfig carries lastUpdateId over from the stored config (an edit never resets it)', () => {
    const current = { botToken: 'tok', allowedChatIds: ['42'], lastUpdateId: 99 };
    expect(normalizeConfig(fields, { allowedChatIds: ['42', '43'] }, current)).toEqual({ botToken: 'tok', allowedChatIds: ['42', '43'], lastUpdateId: 99 });
    expect(normalizeConfig(fields, { botToken: 'new' }, { botToken: 'tok' })).toEqual({ botToken: 'new' });
  });
  it('adapterSignature changes with name/enabled/config but not with lastUpdateId', () => {
    const a = adapterSignature(row());
    expect(adapterSignature(row({ config: { botToken: 'tok', allowedChatIds: ['42'], lastUpdateId: 5 } }))).toBe(a);
    expect(adapterSignature(row({ config: { botToken: 'tok2', allowedChatIds: ['42'] } }))).not.toBe(a);
    expect(adapterSignature(row({ name: 'other' }))).not.toBe(a);
  });
});

describe('reload hands the replacement the cursor the old adapter left (a re-read row, not the list)', () => {
  it('an edited channel is rebuilt from the row as it is NOW, so an update handled meanwhile is not fetched again', async () => {
    const { svc, channels, built, rows } = make([row()]);
    await svc.reload();
    // the form is saved (allow-list changes) ...
    rows[0]!.config = { ...rows[0]!.config, allowedChatIds: ['42', '43'] };
    // ... and the old adapter's cursor lands in the row only after the list was read
    channels.list.mockImplementationOnce(async () => {
      const snapshot = rows.map((r) => ({ ...r, config: { ...r.config } }));
      rows[0]!.config = { ...rows[0]!.config, lastUpdateId: 777 };
      return snapshot;
    });
    await svc.reload();
    expect(built).toHaveLength(2);
    expect(built[1]!.row.config.lastUpdateId).toBe(777);
  });
});
