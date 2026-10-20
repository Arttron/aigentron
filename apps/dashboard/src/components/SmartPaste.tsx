import { useCallback, useEffect, useRef, useState, type ClipboardEvent } from 'react';
import { smartPaste, type PasteKind } from '@/lib/paste-detect';

interface Applied {
  kind: PasteKind;
  lang: string;
  /** the box before the paste, and what was pasted where — to undo into a plain paste */
  before: string;
  start: number;
  end: number;
  raw: string;
}

const LABEL: Record<PasteKind, string> = { prose: 'text', terminal: 'terminal block', code: 'code block', diff: 'diff block', json: 'JSON block', log: 'log block' };

/**
 * Pasted terminal output / code / logs / diffs / JSON arrive as a fenced block (they render as a terminal-style block in the chat), prose
 * is pasted as usual. A short notice offers "Paste as plain text". Files / images pasted from the clipboard are left to the box's own handler.
 */
export function useSmartPaste(setValue: (v: string) => void) {
  const [applied, setApplied] = useState<Applied | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const onPaste = useCallback(
    (e: ClipboardEvent<HTMLTextAreaElement>) => {
      if (e.clipboardData.files?.length) return;
      const raw = e.clipboardData.getData('text/plain');
      if (!raw) return;
      const ta = e.currentTarget;
      const edit = smartPaste(ta.value, ta.selectionStart, ta.selectionEnd, raw);
      if (!edit) return;
      e.preventDefault();
      setApplied({ kind: edit.kind, lang: edit.lang, before: ta.value, start: ta.selectionStart, end: ta.selectionEnd, raw });
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setApplied(null), 10_000);
      setValue(edit.value);
      requestAnimationFrame(() => {
        ta.focus();
        ta.setSelectionRange(edit.caret, edit.caret);
      });
    },
    [setValue],
  );

  const asPlain = useCallback(() => {
    if (!applied) return;
    setValue(applied.before.slice(0, applied.start) + applied.raw + applied.before.slice(applied.end));
    setApplied(null);
  }, [applied, setValue]);

  const notice = applied ? (
    <div role="status" style={{ fontSize: 12, opacity: 0.8, padding: '2px 4px' }}>
      Pasted as a {LABEL[applied.kind]}
      {applied.lang && applied.lang !== 'text' ? ` (${applied.lang})` : ''} ·{' '}
      <button type="button" onClick={asPlain} style={{ all: 'unset', cursor: 'pointer', textDecoration: 'underline' }}>
        paste as plain text
      </button>
    </div>
  ) : null;

  return { onPaste, notice };
}
