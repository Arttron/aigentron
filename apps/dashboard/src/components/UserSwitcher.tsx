import { useEffect, useState } from 'react';
import type { User } from '@lds/shared';
import { api, getActingUserId, setActingUserId } from '@/lib/api';
import styles from './UserSwitcher.module.css';

/**
 * Picks the "acting user" whose id is sent as `x-lds-user` on write actions.
 * No auth in v1 — this is an attribution/role selector, defaulting to the first
 * user (the seeded operator).
 */
export function UserSwitcher() {
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
