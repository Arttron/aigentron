import { useEffect, useRef, useState } from 'react';
import styles from './AttachMenu.module.css';

export type AttachKind = 'file' | 'camera' | 'task';

/**
 * The 📎 menu of the message / new-task forms. A button that opens a small list — NOT a <select>: on phones a select opens the system picker, and
 * after it closes the browser no longer treats the tap as a user gesture, so a file chooser opened from its change event is blocked (iOS Safari,
 * some Android browsers). Here the file chooser is opened straight from the tap on the menu item.
 */
export function AttachMenu({ onPick, disabled, busy, compact }: { onPick: (kind: AttachKind) => void; disabled?: boolean; busy?: boolean; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState({ up: false, right: false });
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  // open towards the side that has room (a phone's screen edge / the bottom dock)
  const toggle = () => {
    if (!open && root.current) {
      const r = root.current.getBoundingClientRect();
      setPlace({ up: window.innerHeight - r.bottom < 200 && r.top > 200, right: r.left + 230 > window.innerWidth });
    }
    setOpen((o) => !o);
  };

  const choose = (kind: AttachKind) => {
    setOpen(false);
    onPick(kind); // runs inside the tap: the file chooser may open
  };

  return (
    <div className={styles.root} ref={root}>
      <button type="button" className={compact ? styles.iconBtn : styles.btn} disabled={disabled || busy} aria-haspopup="menu" aria-expanded={open} aria-label="Attach" onClick={toggle}>
        {busy ? (compact ? '…' : 'Uploading…') : compact ? '📎' : '📎 Attach…'}
      </button>
      {open && (
        <div className={`${styles.menu} ${place.up ? styles.up : styles.down} ${place.right ? styles.right : ""}`} role="menu">
          <button type="button" role="menuitem" onClick={() => choose('file')}>
            🖼 Image / video / file
          </button>
          <button type="button" role="menuitem" onClick={() => choose('camera')}>
            📷 Camera
          </button>
          <button type="button" role="menuitem" onClick={() => choose('task')}>
            🔗 Task
          </button>
        </div>
      )}
    </div>
  );
}
