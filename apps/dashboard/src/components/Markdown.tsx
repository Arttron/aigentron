import { memo, useMemo, useState, type ReactNode } from 'react';
import { parseInline, parseMarkdown, type Inline } from '@/lib/markdown-parse';
import styles from './Markdown.module.css';

function renderInline(tokens: Inline[]): ReactNode[] {
  return tokens.map((t, i) => {
    switch (t.t) {
      case 'code':
        return <code key={i} className={styles.inlineCode}>{t.v}</code>;
      case 'bold':
        return <strong key={i}>{renderInline(t.c)}</strong>;
      case 'italic':
        return <em key={i}>{renderInline(t.c)}</em>;
      case 'link':
        return (
          <a key={i} href={t.href} target="_blank" rel="noopener noreferrer nofollow">
            {t.v}
          </a>
        );
      default:
        return t.v;
    }
  });
}

export function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(code).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => undefined,
    );
  };
  return (
    <div className={styles.codeWrap}>
      <div className={styles.codeHead}>
        <span>{lang || 'text'}</span>
        <button type="button" className={styles.copy} onClick={copy}>
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
      <pre className={styles.code}>{code}</pre>
    </div>
  );
}

/** Renders chat text as React elements (never raw HTML). */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <div className={styles.md} dir="auto">
      {blocks.map((b, i) => {
        switch (b.t) {
          case 'h':
            return <div key={i} className={styles.h} data-level={Math.min(b.level, 3)}>{renderInline(b.c)}</div>;
          case 'code':
            return <CodeBlock key={i} lang={b.lang} code={b.v} />;
          case 'ul':
            return <ul key={i}>{b.items.map((it, j) => <li key={j}>{renderInline(it)}</li>)}</ul>;
          case 'ol':
            return <ol key={i}>{b.items.map((it, j) => <li key={j}>{renderInline(it)}</li>)}</ol>;
          case 'table':
            return (
              <div key={i} className={styles.tableWrap} tabIndex={0} role="region" aria-label="table">
                <table className={styles.table}>
                  <thead>
                    <tr>
                      {b.head.map((c, j) => (
                        <th key={j} style={b.align[j] ? { textAlign: b.align[j]! } : undefined}>{renderInline(c)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, k) => (
                      <tr key={k}>
                        {r.map((c, j) => (
                          <td key={j} style={b.align[j] ? { textAlign: b.align[j]! } : undefined} className={b.align[j] === 'right' ? styles.num : undefined}>
                            {renderInline(c)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case 'quote':
            return <blockquote key={i}>{renderInline(b.c)}</blockquote>;
          default:
            return <p key={i}>{renderInline(b.c)}</p>;
        }
      })}
    </div>
  );
});

export { parseInline };
