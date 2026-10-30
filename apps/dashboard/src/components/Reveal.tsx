import { useEffect, useMemo, useRef, useState } from 'react';
import { Markdown } from './Markdown';
import { MIN_CHARS, wordEnds, wordsShown } from '@/lib/reveal';
import { useMedia } from '@/lib/use-media';

/** Messages already shown in full this session: remounting (a filter, a tab) must not replay them. */
const shown = new Set<string>();
/** Texts already read in full: a final answer that begins with one of them (the run's answer put in front of its closing line) continues after it. */
const shownTexts: string[] = [];
const remember = (id: string, text: string) => {
  shown.add(id);
  shownTexts.push(text);
  if (shownTexts.length > 30) shownTexts.shift();
};

/**
 * A new message appears word by word instead of all at once. Only for a message that arrived while the chat was open (`live`); skipped for the
 * «reduce motion» setting, short messages and a hidden tab; a click on the message shows the rest. `onGrow` lets the chat keep following the bottom.
 */
export function RevealMarkdown({ id, text, live, onGrow }: { id: string; text: string; live: boolean; onGrow?: () => void }) {
  const reduced = useMedia('(prefers-reduced-motion: reduce)');
  const ends = useMemo(() => wordEnds(text), [text]);
  const from = useMemo(() => {
    const prior = shownTexts.filter((t) => t.length >= MIN_CHARS && text.startsWith(t)).sort((a, b) => b.length - a.length)[0];
    return prior ? wordEnds(prior).length : 0;
  }, [text]);
  const play = live && !reduced && !shown.has(id) && text.length >= MIN_CHARS && ends.length - from > 1;
  const [n, setN] = useState(play ? Math.max(1, from) : ends.length);
  const grow = useRef(onGrow);
  grow.current = onGrow;

  useEffect(() => {
    if (!play) {
      setN(ends.length);
      return;
    }
    const start = performance.now();
    let raf = 0;
    let last = 0;
    const finish = () => {
      remember(id, text);
      setN(ends.length);
      grow.current?.();
    };
    const tick = (now: number) => {
      const k = Math.min(ends.length, from + wordsShown(ends.length - from, now - start));
      if (k !== last) {
        last = k;
        setN(k);
        grow.current?.();
      }
      if (k >= ends.length) remember(id, text);
      else raf = requestAnimationFrame(tick);
    };
    const onHide = () => {
      if (document.hidden) {
        cancelAnimationFrame(raf);
        finish();
      }
    };
    document.addEventListener('visibilitychange', onHide);
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', onHide);
    };
  }, [play, ends, id, text, from]);

  const typing = n < ends.length;
  const visible = typing ? text.slice(0, ends[Math.max(0, n - 1)]) : text;
  return (
    <div
      onClick={typing ? () => { remember(id, text); setN(ends.length); } : undefined}
      title={typing ? 'Click to show the whole message' : undefined}
      style={typing ? { cursor: 'pointer' } : undefined}
    >
      <Markdown text={visible} />
    </div>
  );
}
