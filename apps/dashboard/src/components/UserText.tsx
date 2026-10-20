import { memo, useMemo } from 'react';
import { hasFence, splitFences } from '@/lib/user-text';
import { CodeBlock } from './Markdown';

/**
 * What the person wrote, shown as they wrote it — except fenced blocks (pasted terminal output / code), which become terminal-style code
 * blocks with a copy button. A message without a fence renders as plain text, exactly as before.
 */
export const UserText = memo(function UserText({ text, className }: { text: string; className?: string }) {
  const segments = useMemo(() => (hasFence(text) ? splitFences(text) : null), [text]);
  if (!segments) return <span className={className} dir="auto">{text}</span>;
  return (
    <div className={className} dir="auto" style={{ display: 'block', minWidth: 0 }}>
      {segments.map((s, i) =>
        s.t === 'code' ? (
          <CodeBlock key={i} lang={s.lang || 'text'} code={s.v} />
        ) : (
          <div key={i} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {s.v}
          </div>
        ),
      )}
    </div>
  );
});
