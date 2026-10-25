import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import styles from './Collapsible.module.css';

/**
 * Shows at most `lines` lines of its content and a "Show more" below when there is more. The cut is by height (the content is real, rendered
 * Markdown, so it cannot be sliced as text); a short content looks exactly as before.
 */
export function Collapsible({ children, lines = 10, resetKey }: { children: ReactNode; lines?: number; resetKey?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const [hiddenLines, setHiddenLines] = useState(0);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const lh = Number.parseFloat(getComputedStyle(el).lineHeight) || 20;
    const max = lh * lines;
    el.style.setProperty('--collapsed-height', `${max}px`);
    const full = el.scrollHeight;
    setOverflows(full > max + lh); // a single extra line is not worth hiding
    setHiddenLines(Math.max(0, Math.round((full - max) / lh)));
  }, [resetKey, lines, children]);

  const collapsed = overflows && !open;
  return (
    <div className={styles.wrap}>
      <div ref={box} className={collapsed ? styles.collapsed : undefined}>
        {children}
      </div>
      {overflows && (
        <button type="button" className={styles.toggle} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? '▴ Show less' : `▾ Show more (${hiddenLines} more lines)`}
        </button>
      )}
    </div>
  );
}
