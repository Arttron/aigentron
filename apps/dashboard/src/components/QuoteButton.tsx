import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { emitQuote, quoteText } from '@/lib/quote';
import copyStyles from './CopyButton.module.css';
import styles from './QuoteButton.module.css';

/** A small "quote this message" icon next to the copy icon: the whole message goes into the message box as a quote. */
export function QuoteButton({ scope, text, label = 'Quote this message' }: { scope: string; text: string; label?: string }) {
  if (!text.trim()) return null;
  return (
    <button type="button" className={copyStyles.btn} title={label} aria-label={label} onClick={() => emitQuote(scope, quoteText(text))}>
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
        <path d="M3 11.5V8.2C3 6 4.2 4.6 6.2 4.2M9 11.5V8.2c0-2.2 1.2-3.6 3.2-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        <path d="M3 8.5h3v3H3zM9 8.5h3v3H9z" fill="currentColor" stroke="none" />
      </svg>
    </button>
  );
}

interface Picked {
  text: string;
  /** where to show the button: the middle of the selection's top edge, in the viewport */
  x: number;
  y: number;
}

/**
 * A part of a message selected with the mouse or the finger: a small "Quote" button appears over the selection, and a click puts exactly that text into the
 * message box as a quote. Only a selection inside `container` counts (never the message box itself or the page's other texts).
 */
export function SelectionQuote({ scope, container }: { scope: string; container: React.RefObject<HTMLElement | null> }) {
  const [picked, setPicked] = useState<Picked | null>(null);

  const check = useCallback(() => {
    const sel = window.getSelection();
    const root = container.current;
    if (!sel || sel.isCollapsed || !sel.rangeCount || !root) return setPicked(null);
    const range = sel.getRangeAt(0);
    const a = range.commonAncestorContainer;
    const node = a.nodeType === 1 ? (a as Element) : a.parentElement;
    if (!node || !root.contains(node) || node.closest('textarea, input, button, [data-no-quote]')) return setPicked(null);
    const text = sel.toString().trim();
    if (!text) return setPicked(null);
    const r = range.getBoundingClientRect();
    if (!r.width && !r.height) return setPicked(null);
    setPicked({ text, x: r.left + r.width / 2, y: r.top });
  }, [container]);

  useEffect(() => {
    // the selection changes many times while a finger drags its handles: look once it has settled; a mouse button released / a key lifted settles it at once
    let timer: ReturnType<typeof setTimeout> | undefined;
    const soon = () => {
      clearTimeout(timer);
      timer = setTimeout(check, 180);
    };
    const now = () => setTimeout(check, 0);
    document.addEventListener('selectionchange', soon);
    document.addEventListener('mouseup', now);
    document.addEventListener('keyup', now);
    document.addEventListener('touchend', soon);
    // the button goes with a scroll: its place was worked out for the old one
    const hide = () => setPicked(null);
    const el = container.current;
    el?.addEventListener('scroll', hide, { passive: true });
    // the page itself may scroll under the fixed button too (any scrolling box, so: capture)
    window.addEventListener('scroll', hide, { passive: true, capture: true });
    window.addEventListener('resize', hide);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('selectionchange', soon);
      document.removeEventListener('mouseup', now);
      document.removeEventListener('keyup', now);
      document.removeEventListener('touchend', soon);
      el?.removeEventListener('scroll', hide);
      window.removeEventListener('scroll', hide, { capture: true });
      window.removeEventListener('resize', hide);
    };
  }, [check, container]);

  if (!picked) return null;
  const left = Math.min(Math.max(picked.x, 56), window.innerWidth - 56);
  const top = picked.y < 44 ? picked.y + 28 : picked.y - 38; // above the selection; below it when it is at the very top
  return createPortal(
    <button
      type="button"
      className={styles.pop}
      style={{ left, top }}
      // the selection must survive the press (a click would clear it before it is read)
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        emitQuote(scope, quoteText(picked.text));
        window.getSelection()?.removeAllRanges();
        setPicked(null);
      }}
    >
      ❝ Quote
    </button>,
    document.body,
  );
}
