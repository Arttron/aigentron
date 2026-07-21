'use client';

import { useCallback, useEffect, useState } from 'react';
import { USER_ROLES, type ChannelKind, type User, type UserRole } from '@lds/shared';
import { api, getActingUserId } from '@/lib/api';
import { Card, SectionTitle, Field, Row, Button, Modal, Badge, Muted, ErrorText } from '@/components/ui';
import styles from './UsersManager.module.css';

const CHANNELS: ChannelKind[] = ['dashboard', 'slack', 'telegram', 'email'];

type Identity = { channel: ChannelKind; externalId: string };
type FormState = { displayName: string; role: UserRole; identities: Identity[] };
type ModalState = { mode: 'add' } | { mode: 'edit'; user: User } | null;

const emptyForm: FormState = { displayName: '', role: 'task_setter', identities: [] };

export function UsersManager() {
  const [users, setUsers] = useState<User[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<ModalState>(null);
  const [form, setForm] = useState<FormState>(emptyForm);

  const refresh = useCallback(async () => {
    try {
      setUsers(await api.listUsers());
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const openAdd = () => {
    setForm(emptyForm);
    setModal({ mode: 'add' });
  };
  const openEdit = (user: User) => {
    setForm({
      displayName: user.displayName,
      role: user.role,
      identities: user.identities.map((i) => ({ channel: i.channel, externalId: i.externalId })),
    });
    setModal({ mode: 'edit', user });
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const identities = form.identities.filter((i) => i.externalId.trim());
      if (modal?.mode === 'edit') {
        await api.updateUser(modal.user.id, { displayName: form.displayName.trim(), role: form.role, identities });
      } else {
        await api.createUser({ displayName: form.displayName.trim(), role: form.role, identities });
      }
      setModal(null);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (user: User) => {
    if (!window.confirm(`Delete user "${user.displayName}"?`)) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteUser(user.id);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const setIdentity = (idx: number, patch: Partial<Identity>) =>
    setForm((f) => ({
      ...f,
      identities: f.identities.map((i, n) => (n === idx ? { ...i, ...patch } : i)),
    }));

  const acting = getActingUserId();

  return (
    <Card>
      <Row spaceBetween>
        <SectionTitle className={styles.flush}>Users &amp; roles</SectionTitle>
        <Button variant="primary" onClick={openAdd}>
          + Add user
        </Button>
      </Row>
      <Muted className={styles.hint}>
        No auth in v1 — roles scope what the acting user may do at the API. Pick the acting user from
        the 🎭 selector in the header.
      </Muted>

      {users.map((u) => (
        <div key={u.id} className={styles.entry}>
          <Row spaceBetween className={styles.head}>
            <div className={styles.ident}>
              <strong>{u.displayName}</strong>
              <Badge tone="running">{u.role}</Badge>
              {acting === u.id && <Badge tone="neutral">acting</Badge>}
            </div>
            <Row>
              <Button size="sm" onClick={() => openEdit(u)}>
                Edit
              </Button>
              <Button variant="red" size="sm" disabled={busy} onClick={() => remove(u)}>
                Delete
              </Button>
            </Row>
          </Row>
          <Muted className={styles.meta}>
            {u.identities.length
              ? u.identities.map((i) => `${i.channel}:${i.externalId}`).join(' · ')
              : 'no channel identities'}
          </Muted>
        </div>
      ))}

      {error && <ErrorText className={styles.error}>{error}</ErrorText>}

      {modal && (
        <Modal
          title={modal.mode === 'edit' ? `Edit user: ${modal.user.displayName}` : 'Add user'}
          onClose={() => setModal(null)}
        >
          <Field label="Display name">
            <input
              value={form.displayName}
              onChange={(e) => setForm((f) => ({ ...f, displayName: e.target.value }))}
              placeholder="Jane Doe"
            />
          </Field>
          <Field label="Role">
            <select
              value={form.role}
              onChange={(e) => setForm((f) => ({ ...f, role: e.target.value as UserRole }))}
            >
              {USER_ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Channel identities">
            <div className={styles.identities}>
              {form.identities.map((i, idx) => (
                <Row key={idx} className={styles.identRow}>
                  <select
                    value={i.channel}
                    onChange={(e) => setIdentity(idx, { channel: e.target.value as ChannelKind })}
                  >
                    {CHANNELS.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                  <input
                    className={styles.identInput}
                    value={i.externalId}
                    placeholder="external id (e.g. U0123 / @user)"
                    onChange={(e) => setIdentity(idx, { externalId: e.target.value })}
                  />
                  <Button
                    size="sm"
                    variant="red"
                    onClick={() =>
                      setForm((f) => ({ ...f, identities: f.identities.filter((_, n) => n !== idx) }))
                    }
                  >
                    ✕
                  </Button>
                </Row>
              ))}
              <Button
                size="sm"
                onClick={() =>
                  setForm((f) => ({ ...f, identities: [...f.identities, { channel: 'slack', externalId: '' }] }))
                }
              >
                + Add identity
              </Button>
            </div>
          </Field>

          <Row spaceBetween className={styles.actions}>
            <Button onClick={() => setModal(null)}>Cancel</Button>
            <Button variant="primary" disabled={busy || !form.displayName.trim()} onClick={submit}>
              {modal.mode === 'edit' ? 'Save' : 'Create'}
            </Button>
          </Row>
        </Modal>
      )}
    </Card>
  );
}
