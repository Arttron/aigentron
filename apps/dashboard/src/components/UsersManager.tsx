import { useCallback, useEffect, useState } from 'react';
import { USER_ROLES, type ChannelKind, type User, type UserRole } from '@lds/shared';
import { api, getActingUserId } from '@/lib/api';
import { passwordsApi } from '@/lib/auth';
import { useAuth } from '@/lib/auth-context';
import { Card, SectionTitle, Field, Row, Button, Modal, Muted, ErrorText } from '@/components/ui';
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
  const { status } = useAuth();
  const signInOn = !!status?.configured;
  const [hasPw, setHasPw] = useState<Record<string, boolean>>({});
  const [pwFor, setPwFor] = useState<User | null>(null);
  const [pw, setPw] = useState('');
  const [pwError, setPwError] = useState<string | null>(null);

  const loadPw = useCallback(async () => {
    if (!signInOn) return;
    const rows = await passwordsApi.overview();
    setHasPw(Object.fromEntries(rows.map((r) => [r.id, r.hasPassword])));
  }, [signInOn]);
  useEffect(() => {
    void loadPw();
  }, [loadPw]);

  const savePw = async () => {
    if (!pwFor) return;
    setPwError(null);
    const r = await passwordsApi.set(pwFor.id, pw).catch(() => null);
    if (!r?.ok) return setPwError(r?.data.error ?? 'Could not set the password.');
    setPwFor(null);
    setPw('');
    await loadPw();
  };
  const removePw = async (user: User) => {
    if (!window.confirm(`Remove ${user.displayName}'s password? They will not be able to sign in.`)) return;
    const r = await passwordsApi.remove(user.id).catch(() => null);
    if (!r?.ok) setError(r?.data.error ?? 'Could not remove the password.');
    await loadPw();
  };

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
        {signInOn
          ? 'Everyone signs in by picking their name and typing their own password; their role decides what they may do. Set or reset a person\'s password with 🔑 below.'
          : 'Sign-in is off: roles scope what the acting user may do, picked from the 🎭 selector in the header. Turn sign-in on in Settings → General → Security — then each user gets their own password here.'}
      </Muted>

      {users.map((u) => (
        <div key={u.id} className={styles.card}>
          <div className={styles.top}>
            <strong className={styles.name}>{u.displayName}</strong>
            <span className={styles.role}>
              <span className={styles.dot} data-role={u.role} aria-hidden />
              {u.role.replace('_', ' ')}
            </span>
          </div>
          <div className={styles.facts}>
            {signInOn && (
              <span className={hasPw[u.id] ? styles.pwOn : styles.pwOff}>{hasPw[u.id] ? '🔑 has a password' : '⚠ no password — cannot sign in'}</span>
            )}
            {!signInOn && acting === u.id && <span className={styles.pwOn}>acting user</span>}
            <span>
              {u.identities.length
                ? u.identities.map((i) => `${i.channel}:${i.externalId}`).join(' · ')
                : 'no channel identities'}
            </span>
          </div>
          <div className={styles.buttons}>
            {signInOn && (
              <Button
                onClick={() => {
                  setPwFor(u);
                  setPw('');
                  setPwError(null);
                }}
              >
                🔑 {hasPw[u.id] ? 'Reset password' : 'Set password'}
              </Button>
            )}
            {signInOn && hasPw[u.id] && <Button onClick={() => removePw(u)}>Remove password</Button>}
            <Button onClick={() => openEdit(u)}>Edit</Button>
            <Button variant="red" disabled={busy} onClick={() => remove(u)}>
              Delete
            </Button>
          </div>
        </div>
      ))}

      {error && <ErrorText className={styles.error}>{error}</ErrorText>}

      {pwFor && (
        <Modal title={`${hasPw[pwFor.id] ? 'Reset' : 'Set'} password: ${pwFor.displayName}`} onClose={() => setPwFor(null)}>
          <Muted>They are signed out everywhere and use the new password from now on. Tell them the password in person — it is not shown again.</Muted>
          <Field label="New password (at least 8 characters)">
            <input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
          </Field>
          {pwError && <ErrorText>{pwError}</ErrorText>}
          <Row>
            <Button variant="primary" disabled={pw.length < 8} onClick={savePw}>
              Save password
            </Button>
            <Button onClick={() => setPwFor(null)}>Cancel</Button>
          </Row>
        </Modal>
      )}

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
