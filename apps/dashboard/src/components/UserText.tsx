import { memo, useMemo } from 'react';
import { hasFence, splitFences } from '@/lib/user-text';
import { userBlocks } from '@/lib/user-markdown';
import { CodeBlock, UserBlocks } from './Markdown';

/**
 * What the person wrote. Fenced blocks (pasted terminal output / code) become terminal-style code blocks with a copy button; text the composer's formatting
 * made (bold, italic, strike, code, links, lists, quotes) is shown formatted. A message with no formatting is shown exactly as typed.
 */
export const UserText = memo(function UserText({ text, className }: { text: string; className?: string }) {
  const parts = useMemo(() => {
    const segments = hasFence(text) ? splitFences(text) : [{ t: 'text' as const, v: text }];
    const out = segments.map((s) => (s.t === 'code' ? s : { t: 'text' as const, v: s.v, blocks: userBlocks(s.v) }));
    return out;
  }, [text]);
  // nothing formatted anywhere: as before
  if (parts.length === 1 && parts[0]!.t === 'text' && !('blocks' in parts[0]! && parts[0]!.blocks)) return <span className={className} dir="auto">{text}</span>;
  return (
    <div className={className} dir="auto" style={{ display: 'block', minWidth: 0 }}>
      {parts.map((s, i) =>
        s.t === 'code' ? (
          <CodeBlock key={i} lang={s.lang || 'text'} code={s.v} />
        ) : s.blocks ? (
          <UserBlocks key={i} blocks={s.blocks} />
        ) : (
          <div key={i} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {s.v}
          </div>
        ),
      )}
    </div>
  );
});
