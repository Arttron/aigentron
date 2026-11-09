import { useCallback, useLayoutEffect, useMemo, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { highlightLines, type HlClass, type HlLine } from '@/lib/md-highlight';
import styles from './LiveFormat.module.css';

/**
 * Live formatting inside the message box. The box stays a plain `<textarea>` (caret, selection, paste, voice, input methods and undo all keep working); a copy of
 * its text is drawn over it, exactly aligned, with the Markdown marks dimmed and the formatted parts styled; the real text is made see-through.
 * Only styles that do not change the width of a letter are used, so the copy can never drift away from the caret.
 */
interface Metrics {
  box: CSSProperties;
}

const COPY: (keyof CSSStyleDeclaration)[] = [
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'fontStretch',
  'lineHeight',
  'letterSpacing',
  'wordSpacing',
  'textTransform',
  'textIndent',
  'tabSize',
  'textAlign',
  'whiteSpace',
  'overflowWrap',
  'wordBreak',
  'color',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
];

function measure(ta: HTMLTextAreaElement): Metrics {
  const cs = window.getComputedStyle(ta);
  // The box's size with its fraction (offsetWidth is rounded): a copy that is a fraction of a pixel wider fits one more letter on a line at the very edge, wraps
  // differently from the box, and the caret shows a line below the text — seen on a narrow phone-width box, where lines are short and edges are met often.
  const rect = ta.getBoundingClientRect();
  const box: Record<string, string | number> = {
    left: ta.offsetLeft,
    top: ta.offsetTop,
    width: rect.width,
    height: rect.height,
    boxSizing: 'border-box',
    borderStyle: 'solid',
    borderColor: 'transparent',
  };
  for (const k of COPY) box[k as string] = cs[k] as string;
  // a vertical scrollbar takes width from the text area: the copy loses the same width
  const bars = Math.round(ta.offsetWidth - ta.clientWidth - (parseFloat(cs.borderLeftWidth) || 0) - (parseFloat(cs.borderRightWidth) || 0));
  if (bars > 0) box.paddingRight = `${(parseFloat(cs.paddingRight) || 0) + bars}px`;
  return { box: box as CSSProperties };
}

const CLS: Record<HlClass, string> = {
  mark: styles.mark!,
  bold: styles.bold!,
  italic: styles.italic!,
  strike: styles.strike!,
  code: styles.code!,
  link: styles.link!,
  url: styles.url!,
  bullet: styles.bullet!,
  quote: styles.quote!,
  lang: styles.lang!,
};

function renderLines(lines: HlLine[]): ReactNode {
  return lines.map((l, i) => (
    <div key={i} className={l.kind === 'plain' ? styles.line : styles.block} dir="auto">
      {l.segs.length ? l.segs.map((s, j) => (s.cls.length ? <span key={j} className={s.cls.map((c) => CLS[c]).join(' ')}>{s.text}</span> : s.text)) : null}
      {l.segs.length === 0 || l.segs.every((s) => !s.text) ? '​' : null}
    </div>
  ));
}

/**
 * `className` goes on the textarea (its own text becomes see-through once the copy is in place), `overlay` is rendered right after it. The two must share
 * a parent, since the copy is placed by the textarea's own offsets.
 */
export function useLiveFormat(ref: RefObject<HTMLTextAreaElement | null>, value: string): { className: string; overlay: ReactNode } {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [scroll, setScroll] = useState(0);

  const update = useCallback(() => {
    const ta = ref.current;
    if (!ta || !ta.isConnected) return;
    const next = measure(ta);
    setMetrics((prev) => (prev && JSON.stringify(prev.box) === JSON.stringify(next.box) ? prev : next));
    setScroll((s) => (s === ta.scrollTop ? s : ta.scrollTop));
  }, [ref]);

  // The box may be mounted later than this hook runs (a panel that opens, a layout that swaps) or replaced by another element: follow the element itself.
  const [node, setNode] = useState<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    if (ref.current !== node) setNode(ref.current);
  });
  // Measured after EVERY render of the host: anything above the box (the toolbar, a notice, chips) moves it without changing its size or its text, and the
  // measurement is cheap (the result is compared before it is stored).
  useLayoutEffect(() => {
    update();
  });
  useLayoutEffect(() => {
    const ta = node;
    if (!ta) return;
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    ro?.observe(ta);
    // a neighbour growing or shrinking above the box moves it: the parent's size changes then too
    if (ta.parentElement) ro?.observe(ta.parentElement);
    ta.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    void document.fonts?.ready.then(update);
    return () => {
      ro?.disconnect();
      ta.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [node, update]);

  const lines = useMemo(() => highlightLines(value), [value]);
  const overlay = metrics ? (
    <div aria-hidden className={styles.overlay} style={metrics.box}>
      <div className={styles.inner} style={{ transform: `translateY(${-scroll}px)` }}>
        {renderLines(lines)}
      </div>
    </div>
  ) : null;
  return { className: metrics ? styles.live! : '', overlay };
}
