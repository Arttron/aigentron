import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type RefObject } from 'react';
import { applyFormat, continueList, diffRange, enterInFence, insertQuote, pasteLinkOverSelection, shortcutAction, type Edit, type FormatAction } from '@/lib/md-edit';
import styles from './FormatBar.module.css';

const STORE = 'lds.fmtbar';
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const MOD = isMac ? '⌘' : 'Ctrl+';

/** The toolbar is folded by default (the "Aa" button opens it for good; it also appears by itself over a selection); the choice is remembered. */
function initialOpen(): boolean {
  try {
    return window.localStorage.getItem(STORE) === '1';
  } catch {
    return false;
  }
}

const BUTTONS: { action: FormatAction; label: string; title: string; text: string; cls?: string }[] = [
  { action: 'bold', label: 'Bold', title: `Bold (${MOD}B)`, text: 'B', cls: 'b' },
  { action: 'italic', label: 'Italic', title: `Italic (${MOD}I)`, text: 'I', cls: 'i' },
  { action: 'strike', label: 'Strikethrough', title: `Strikethrough (${MOD}⇧X)`, text: 'S', cls: 's' },
  { action: 'link', label: 'Link', title: `Link (${MOD}K)`, text: '🔗' },
  { action: 'ul', label: 'Bulleted list', title: `Bulleted list (${MOD}⇧8)`, text: '•≡' },
  { action: 'ol', label: 'Numbered list', title: `Numbered list (${MOD}⇧7)`, text: '1≡' },
  { action: 'quote', label: 'Quote', title: `Quote (${MOD}⇧9)`, text: '❝' },
  { action: 'code', label: 'Code', title: `Code (${MOD}⇧C)`, text: '</>' },
  { action: 'codeblock', label: 'Code block', title: `Code block (${MOD}⌥⇧C)`, text: '{ }' },
];

export interface Formatting {
  open: boolean;
  /** some text is selected in the box: the formatting buttons float over it even when the toolbar is folded */
  selected: boolean;
  toggle: () => void;
  apply: (action: FormatAction) => void;
  /** put a quote (a `> …` block) into the box: at the caret when the box has focus, else at the end; the caret lands below it, ready for the reply */
  insertQuote: (quote: string) => void;
  /** call first in the textarea's onKeyDown: true = the key was handled (shortcut, or Shift+Enter in a list) */
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  /** call first in onPaste: true = handled (an address pasted over a selected word) */
  onPaste: (e: ClipboardEvent<HTMLTextAreaElement>) => boolean;
}

/**
 * Slack-like formatting for a plain `<textarea>`: the text stays Markdown (what agents read and the conversation shows formatted); the toolbar and the
 * shortcuts only edit it. Edits go through the browser's own editing command, so Ctrl+Z undoes a formatting step like any typing.
 */
export function useFormatting(ref: RefObject<HTMLTextAreaElement | null>, setValue: (v: string) => void): Formatting {
  const [open, setOpen] = useState<boolean>(initialOpen);
  const [selected, setSelected] = useState(false);
  const pending = useRef<Edit | null>(null);
  const toggle = useCallback(() => {
    setOpen((o) => {
      try {
        window.localStorage.setItem(STORE, o ? '0' : '1');
      } catch {
        /* not remembered */
      }
      return !o;
    });
  }, []);

  // a selection in the box makes the buttons appear over it; they go when it is gone or the box loses focus
  useEffect(() => {
    const check = () => {
      const ta = ref.current;
      setSelected(Boolean(ta && document.activeElement === ta && ta.selectionStart !== ta.selectionEnd));
    };
    document.addEventListener('selectionchange', check);
    // text boxes report a selection on the box itself in some browsers: listen there too.
    // NOT 'input': a state change from a native listener on the box re-renders (and rewrites the box's value) BEFORE React's own onChange sees the edit, so
    // React finds nothing changed and the edit is thrown away — deleting or typing over a selection did nothing. 'selectionchange' follows every edit anyway.
    const ta = ref.current;
    const events = ['select', 'keyup', 'mouseup', 'touchend', 'blur'];
    for (const n of events) ta?.addEventListener(n, check);
    return () => {
      document.removeEventListener('selectionchange', check);
      for (const n of events) ta?.removeEventListener(n, check);
    };
  }, [ref]);

  // the fallback path (no editing command): the text went through React, and the selection is put back once it has rendered
  useLayoutEffect(() => {
    const p = pending.current;
    const ta = ref.current;
    if (p && ta && ta.value === p.text) {
      ta.setSelectionRange(p.start, p.end);
      pending.current = null;
    }
  });

  const commit = useCallback(
    (next: Edit) => {
      const ta = ref.current;
      if (!ta) return;
      ta.focus();
      const d = diffRange(ta.value, next.text);
      let done = false;
      try {
        ta.setSelectionRange(d.from, d.to);
        done = d.insert ? document.execCommand('insertText', false, d.insert) : d.from === d.to ? true : document.execCommand('delete');
      } catch {
        done = false;
      }
      if (done && ta.value === next.text) {
        ta.setSelectionRange(next.start, next.end);
        return;
      }
      pending.current = next;
      setValue(next.text);
    },
    [ref, setValue],
  );

  const current = (): Edit | null => {
    const ta = ref.current;
    return ta ? { text: ta.value, start: ta.selectionStart, end: ta.selectionEnd } : null;
  };

  const apply = useCallback(
    (action: FormatAction) => {
      const e = current();
      if (e) commit(applyFormat(e, action));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [commit],
  );

  const quote = useCallback(
    (q: string) => {
      const ta = ref.current;
      if (!ta) return;
      const end = ta.value.length;
      const at: Edit = document.activeElement === ta ? { text: ta.value, start: ta.selectionStart, end: ta.selectionEnd } : { text: ta.value, start: end, end };
      commit(insertQuote(at, q));
      ta.focus();
      ta.scrollTop = ta.scrollHeight;
    },
    [ref, commit],
  );

  const onKeyDown = useCallback(
    (ev: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (ev.nativeEvent.isComposing) return false; // an input method is mid-word
      const action = shortcutAction(ev);
      if (action) {
        ev.preventDefault();
        apply(action);
        return true;
      }
      if (ev.key === 'Enter' && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
        // in a code block (or right after typing the opening ```) Enter is a new line — and the block is closed for you
        const e = current();
        const inFence = e ? enterInFence(e) : null;
        if (inFence) {
          ev.preventDefault();
          commit(inFence);
          return true;
        }
      }
      // Enter sends (as always); Shift+Enter inside a list / quote continues it
      if (ev.key === 'Enter' && ev.shiftKey && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
        const e = current();
        const next = e ? continueList(e) : null;
        if (next) {
          ev.preventDefault();
          commit(next);
          return true;
        }
      }
      return false;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [apply, commit],
  );

  const onPaste = useCallback(
    (ev: ClipboardEvent<HTMLTextAreaElement>): boolean => {
      const e = current();
      const clip = ev.clipboardData?.getData('text/plain') ?? '';
      const next = e ? pasteLinkOverSelection(e, clip) : null;
      if (!next) return false;
      ev.preventDefault();
      commit(next);
      return true;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [commit],
  );

  return { open, selected, toggle, apply, insertQuote: quote, onKeyDown, onPaste };
}

/** The little "Aa" button that folds and unfolds the toolbar. */
export function FormatToggle({ fmt, className }: { fmt: Formatting; className?: string }) {
  return (
    <button type="button" className={`${styles.toggle} ${className ?? ''}`} aria-pressed={fmt.open} aria-label="Formatting" title={fmt.open ? 'Hide formatting' : 'Show formatting'} onMouseDown={(e) => e.preventDefault()} onClick={fmt.toggle}>
      Aa
    </button>
  );
}

/**
 * The formatting buttons above the message box. Opened with "Aa" they stay as a row; while folded they float over the box whenever text is selected. The
 * buttons never take focus, so the selection in the box stays where it was.
 */
export function FormatBar({ fmt, toggle = true }: { fmt: Formatting; toggle?: boolean }) {
  const buttons = (
    <div className={styles.buttons}>
      {BUTTONS.map((b) => (
        <button key={b.action} type="button" className={`${styles.btn} ${b.cls ? styles[b.cls] : ''}`} aria-label={b.label} title={b.title} onMouseDown={(e) => e.preventDefault()} onClick={() => fmt.apply(b.action)}>
          {b.text}
        </button>
      ))}
    </div>
  );
  if (fmt.open) {
    return (
      <div className={styles.bar} role="toolbar" aria-label="Formatting">
        {buttons}
        {toggle && <FormatToggle fmt={fmt} className={styles.end} />}
      </div>
    );
  }
  return (
    <>
      {toggle && (
        <div className={styles.bar}>
          <FormatToggle fmt={fmt} className={styles.end} />
        </div>
      )}
      {fmt.selected && (
        <div className={styles.anchor}>
          <div className={styles.popover} role="toolbar" aria-label="Formatting" onMouseDown={(e) => e.preventDefault()}>
            {buttons}
          </div>
        </div>
      )}
    </>
  );
}
