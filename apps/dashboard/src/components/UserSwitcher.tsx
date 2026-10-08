import { useEffect, useState } from 'react';
import type { User } from '@lds/shared';
import { api, getActingUserId, setActingUserId } from '@/lib/api';
import { authApi } from '@/lib/auth';
import { useAuth } from '@/lib/auth-context';
import { reconnectSocket } from './AuthGate';
import styles from './UserSwitcher.module.css';

/**
 * With sign-in on: shows who is signed in (their role decides what they may do) and a sign-out link.
 * Without it: picks the "acting user" whose id is sent as `x-lds-user` — an attribution/role selector.
 */
export function UserSwitcher() {
  const { status } = useAuth();
  if (status?.configured && status.me) return <SignedIn name={status.me.displayName} role={status.me.role} />;
  return <ActingUserPicker />;
}

function SignedIn({ name, role }: { name: string; role: string }) {
  const out = async () => {
    await authApi.logout().catch(() => undefined);
    reconnectSocket();
    window.location.assign('/');
  };
  return (
    <span className={styles.wrap} title={`Signed in as ${name} (${role})`}>
      <span aria-hidden>👤</span>
      <span>
        {name} · {role}
      </span>
      <button type="button" className={styles.signOut} onClick={out}>
        Sign out
      </button>
    </span>
  );
}

function ActingUserPicker() {
  const [users, setUsers] = useState<User[]>([]);
  const [current, setCurrent] = useState('');

  useEffect(() => {
    api
      .listUsers()
      .then((list) => {
        setUsers(list);
        const stored = getActingUserId();
        const valid = stored && list.some((u) => u.id === stored) ? stored : list[0]?.id ?? '';
        setCurrent(valid);
        if (valid !== stored) setActingUserId(valid || null);
      })
      .catch(() => undefined);
  }, []);

  if (!users.length) return null;

  const onChange = (id: string) => {
    setCurrent(id);
    setActingUserId(id || null);
  };

  return (
    <label className={styles.wrap} title="Acting user (sent as x-lds-user)">
      <span aria-hidden>🎭</span>
      <select className={styles.select} value={current} onChange={(e) => onChange(e.target.value)}>
        {users.map((u) => (
          <option key={u.id} value={u.id}>
            {u.displayName} · {u.role}
          </option>
        ))}
      </select>
    </label>
  );
}
