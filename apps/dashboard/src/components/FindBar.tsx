import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { clearMatches, findRanges, paintMatches } from '@/lib/find-in-text';
import styles from './FindBar.module.css';

/**
 * Find in this conversation: the matches are painted in the text (the browser's highlight registry), "2 of 3", next / previous. The whole conversation is
 * on the page, so this finds every message. `refreshKey` changes when the conversation does (new lines): the matches are found again.
 */
export function FindBar({ root, refreshKey, onClose, initial = '' }: { root: RefObject<HTMLElement | null>; refreshKey: unknown; onClose: () => void; initial?: string }) {
  const [q, setQ] = useState(initial);
  const [ranges, setRanges] = useState<Range[]>([]);
  const [at, setAt] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => input.current?.focus(), []);
  useEffect(() => () => clearMatches(), []);

  // matches again when the words or the conversation change (a moment after typing)
  useEffect(() => {
    const t = window.setTimeout(() => {
      const el = root.current;
      const found = el && q.trim() ? findRanges(el, q) : [];
      setRanges(found);
      setAt((i) => (i < found.length ? i : 0));
    }, 120);
    return () => window.clearTimeout(t);
  }, [q, refreshKey, root]);

  // paint, and bring the current match into view
  const lastScrolled = useRef<Range | null>(null);
  useEffect(() => {
    const cur = ranges[at] ?? null;
    paintMatches(ranges, cur);
    if (cur && cur !== lastScrolled.current) {
      lastScrolled.current = cur;
      cur.startContainer.parentElement?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [ranges, at]);

  const step = useCallback((d: number) => setAt((i) => (ranges.length ? (i + d + ranges.length) % ranges.length : 0)), [ranges.length]);

  return (
    <div className={styles.bar} role="search" data-find-skip>
      <input
        ref={input}
        className={styles.input}
        type="search"
        value={q}
        placeholder="Find in this conversation"
        aria-label="Find in this conversation"
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
          else if (e.key === 'Enter') {
            e.preventDefault();
            step(e.shiftKey ? -1 : 1);
          }
        }}
      />
      <span className={styles.count} aria-live="polite">
        {q.trim() ? (ranges.length ? `${at + 1} of ${ranges.length}` : 'no matches') : ''}
      </span>
      <button type="button" className={styles.btn} aria-label="Previous match" disabled={!ranges.length} onClick={() => step(-1)}>
        ↑
      </button>
      <button type="button" className={styles.btn} aria-label="Next match" disabled={!ranges.length} onClick={() => step(1)}>
        ↓
      </button>
      <button type="button" className={styles.btn} aria-label={q ? 'Clear the search' : 'Close find'} title={q ? 'Clear (Esc closes)' : 'Close'} onClick={() => (q ? (setQ(''), input.current?.focus()) : onClose())}>
        ×
      </button>
    </div>
  );
}
