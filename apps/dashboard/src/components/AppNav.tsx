import { useCallback, useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { api } from '@/lib/api';
import { usePolling } from '@/lib/use-polling';
import { UserSwitcher } from './UserSwitcher';
import styles from './AppNav.module.css';

interface Item {
  to: string;
  icon: string;
  label: string;
  /** a path prefix that also counts as this item (a task page belongs to Tasks) */
  also?: string;
}

const WORK: Item[] = [
  { to: '/', icon: '📋', label: 'Tasks', also: '/tasks' },
  { to: '/projects', icon: '🗂', label: 'Projects' },
  { to: '/agents', icon: '🧑‍💻', label: 'Agents' },
];
const LIBRARY: Item[] = [
  { to: '/resources', icon: '📚', label: 'Resources' },
  { to: '/knowledge', icon: '🧠', label: 'Knowledge' },
  { to: '/workspace', icon: '📁', label: 'Workspace' },
];
const SYSTEM: Item[] = [
  { to: '/browser', icon: '🌐', label: 'Browser' },
  { to: '/stats', icon: '📊', label: 'Stats' },
  { to: '/settings', icon: '⚙', label: 'Settings' },
];
const MORE = [...LIBRARY, ...SYSTEM];

const isOn = (pathname: string, it: Item): boolean =>
  it.to === '/' ? pathname === '/' || pathname.startsWith('/tasks') : pathname === it.to || pathname.startsWith(`${it.to}/`) || Boolean(it.also && pathname.startsWith(it.also));

/** How many approvals / questions wait for a person (the red badge on Tasks). */
function usePendingCount(): number {
  const [n, setN] = useState(0);
  const refresh = useCallback(() => {
    Promise.all([api.listApprovals('pending').catch(() => []), api.listQuestions('pending').catch(() => [])]).then(([a, q]) => setN(a.length + q.length));
  }, []);
  useEffect(refresh, [refresh]);
  usePolling(refresh, 15_000);
  return n;
}

/**
 * The app's navigation, on every page: a sidebar on wide screens, a bottom bar (Tasks · Projects · Agents · More) on phones and
 * tablets. The badge on Tasks counts what waits for a decision.
 */
export function AppNav() {
  const { pathname } = useLocation();
  const pending = usePendingCount();
  const [more, setMore] = useState(false);
  useEffect(() => setMore(false), [pathname]);

  const link = (it: Item, badge?: number) => (
    <NavLink key={it.to} to={it.to} end={it.to === '/'} className={() => `${styles.item} ${isOn(pathname, it) ? styles.on : ''}`}>
      <span className={styles.icon} aria-hidden>
        {it.icon}
      </span>
      <span className={styles.label}>{it.label}</span>
      {badge ? <span className={styles.badge}>{badge}</span> : null}
    </NavLink>
  );
  const moreOn = MORE.some((it) => isOn(pathname, it));

  return (
    <>
      <aside className={styles.side} aria-label="Main navigation">
        <div className={styles.brand}>🤖 Agent Fleet</div>
        {WORK.map((it) => link(it, it.to === '/' ? pending : 0))}
        <div className={styles.group}>Library</div>
        {LIBRARY.map((it) => link(it))}
        <div className={styles.group}>System</div>
        {SYSTEM.map((it) => link(it))}
        <div className={styles.grow} />
        <div className={styles.user}>
          <UserSwitcher />
        </div>
      </aside>

      <nav className={styles.bar} aria-label="Main navigation">
        {WORK.map((it) => (
          <NavLink key={it.to} to={it.to} end={it.to === '/'} className={() => `${styles.tab} ${isOn(pathname, it) ? styles.on : ''}`}>
            <span className={styles.tabIcon} aria-hidden>
              {it.icon}
              {it.to === '/' && pending > 0 ? <span className={styles.tabBadge}>{pending}</span> : null}
            </span>
            <span>{it.label}</span>
          </NavLink>
        ))}
        <button type="button" className={`${styles.tab} ${moreOn || more ? styles.on : ''}`} onClick={() => setMore((v) => !v)} aria-expanded={more}>
          <span className={styles.tabIcon} aria-hidden>
            ⋯
          </span>
          <span>More</span>
        </button>
      </nav>

      {more && (
        <div className={styles.overlay} onClick={() => setMore(false)}>
          <div className={styles.sheet} onClick={(e) => e.stopPropagation()} role="dialog" aria-label="More">
            <div className={styles.grip} />
            <div className={styles.tiles}>
              {MORE.map((it) => (
                <NavLink key={it.to} to={it.to} className={() => `${styles.tile} ${isOn(pathname, it) ? styles.on : ''}`}>
                  <span className={styles.tileIcon} aria-hidden>
                    {it.icon}
                  </span>
                  <span>{it.label}</span>
                </NavLink>
              ))}
            </div>
            <div className={styles.sheetUser}>
              <UserSwitcher />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
