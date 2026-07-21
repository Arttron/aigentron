'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  api,
  type ChannelInfo,
  type ChannelInput,
  type ChannelKindMeta,
  type ChannelTestResult,
} from '@/lib/api';
import { Card, SectionTitle, Row, Button, Badge, Modal, Muted, ErrorText } from '@/components/ui';
import { ChannelForm } from './ChannelForm';
import styles from './ChannelsManager.module.css';

type ModalState = { mode: 'add' } | { mode: 'edit'; channel: ChannelInfo } | null;

export function ChannelsManager() {
  const [channels, setChannels] = useState<ChannelInfo[]>([]);
  const [kinds, setKinds] = useState<ChannelKindMeta[]>([]);
  const [modal, setModal] = useState<ModalState>(null);
  const [results, setResults] = useState<Record<string, ChannelTestResult>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [list, kindList] = await Promise.all([api.listChannels(), api.listChannelKinds()]);
      setChannels(list);
      setKinds(kindList);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const labelOf = (kind: string) => kinds.find((k) => k.kind === kind)?.label ?? kind;

  const submitForm = async (values: ChannelInput) => {
    if (modal?.mode === 'edit') await api.updateChannel(modal.channel.id, values);
    else await api.createChannel(values);
    setModal(null);
    await refresh();
  };

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const toggle = (c: ChannelInfo) => run(() => api.updateChannel(c.id, { enabled: !c.enabled }));

  const remove = (c: ChannelInfo) => {
    if (!window.confirm(`Delete channel "${c.name}"?`)) return;
    void run(() => api.deleteChannel(c.id));
  };

  const test = async (c: ChannelInfo) => {
    setResults((r) => ({ ...r, [c.id]: undefined as never }));
    try {
      const res = await api.testChannel(c.id);
      setResults((r) => ({ ...r, [c.id]: res }));
    } catch (e) {
      setResults((r) => ({ ...r, [c.id]: { ok: false, error: (e as Error).message } }));
    }
  };

  return (
    <Card>
      <Row spaceBetween>
        <SectionTitle className={styles.flush}>Channels</SectionTitle>
        <Button variant="primary" onClick={() => setModal({ mode: 'add' })}>
          + Add channel
        </Button>
      </Row>
      <Muted className={styles.intro}>
        External chats that drive the orchestrator — post updates, create tasks, and approve from a
        chat. Telegram is available now; more (Slack, WhatsApp, Viber, …) are on the way.
      </Muted>

      {channels.length === 0 && <Muted className={styles.intro}>No channels yet.</Muted>}

      {channels.map((c) => {
        const r = results[c.id];
        const firstSecret = Object.values(c.secrets ?? {})[0];
        return (
          <div key={c.id} className={styles.entry}>
            <Row spaceBetween className={styles.head}>
              <div className={styles.ident}>
                <strong>{c.name}</strong> <Badge tone="neutral">{labelOf(c.kind)}</Badge>
                {c.enabled ? <Badge tone="running">enabled</Badge> : <Badge tone="neutral">disabled</Badge>}
              </div>
              <Row>
                <Button size="sm" onClick={() => test(c)}>Test</Button>
                <Button size="sm" disabled={busy} onClick={() => toggle(c)}>
                  {c.enabled ? 'Disable' : 'Enable'}
                </Button>
                <Button size="sm" onClick={() => setModal({ mode: 'edit', channel: c })}>Edit</Button>
                <Button variant="red" size="sm" disabled={busy} onClick={() => remove(c)}>Delete</Button>
              </Row>
            </Row>
            <Muted className={styles.meta}>
              {firstSecret?.set ? `secret ${firstSecret.hint}` : 'no secret'}
              {Array.isArray(c.config.allowedChatIds) && (c.config.allowedChatIds as string[]).length
                ? ` · ${(c.config.allowedChatIds as string[]).length} allowed chat(s)`
                : ' · no allowed chats'}
            </Muted>
            {r && (
              <div className={r.ok ? styles.ok : styles.fail}>
                {r.ok ? `✓ connected as ${r.info}` : `✗ ${r.error}`}
              </div>
            )}
          </div>
        );
      })}

      {error && <ErrorText className={styles.error}>{error}</ErrorText>}

      {modal && (
        <Modal
          title={modal.mode === 'edit' ? `Edit channel: ${modal.channel.name}` : 'Add channel'}
          onClose={() => setModal(null)}
        >
          <ChannelForm
            initial={modal.mode === 'edit' ? modal.channel : undefined}
            kinds={kinds}
            onSubmit={submitForm}
            onCancel={() => setModal(null)}
          />
        </Modal>
      )}
    </Card>
  );
}
