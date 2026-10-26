import { createContext, memo, useContext, useMemo, useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { docKind } from '@/lib/doc-kinds';
import { DocViewer } from './DocViewer';
import { parseInline, parseMarkdown, type Inline } from '@/lib/markdown-parse';
import styles from './Markdown.module.css';

/** The task whose attachments `![caption](file.png)` in a message refers to (set by the transcript). */
export const MediaTaskContext = createContext<string | undefined>(undefined);

const isVideoName = (n: string) => /\.(mp4|webm|mov|m4v)$/i.test(n);

/** A file of the task, loaded by its name — the agent writes a reference, not the picture again. */
function InlineMedia({ name, alt, from }: { name: string; alt: string; from?: string }) {
  const own = useContext(MediaTaskContext);
  const taskId = from ?? own;
  const [broken, setBroken] = useState(false);
  if (!taskId) return <code className={styles.inlineCode}>{name}</code>;
  const url = api.attachmentUrl(taskId, name);
  if (broken) return <code className={styles.inlineCode} title="not found among this task's files">{name}</code>;
  return (
    <span className={styles.media}>
      {isVideoName(name) ? (
        <video src={url} controls preload="metadata" className={styles.mediaEl} onError={() => setBroken(true)} />
      ) : (
        <a href={url} target="_blank" rel="noopener noreferrer">
          <img src={url} alt={alt || name} loading="lazy" className={styles.mediaEl} onError={() => setBroken(true)} />
        </a>
      )}
      {alt && <span className={styles.mediaCaption}>{alt}</span>}
    </span>
  );
}

/** A link to a file of a task (not a picture): the file stays where it is, the link downloads it. */
function FileLink({ name, label, from }: { name: string; label: string; from?: string }) {
  const own = useContext(MediaTaskContext);
  const taskId = from ?? own;
  const [open, setOpen] = useState(false);
  if (!taskId) return <code className={styles.inlineCode}>{name}</code>;
  const preview = docKind(name) !== null;
  return (
    <>
      <a
        href={api.attachmentUrl(taskId, name)}
        target="_blank"
        rel="noopener noreferrer"
        className={styles.fileLink}
        title={name}
        onClick={preview ? (e) => { e.preventDefault(); setOpen(true); } : undefined}
      >
        📎 {label}
      </a>
      {open && <DocViewer taskId={taskId} name={name} onClose={() => setOpen(false)} />}
    </>
  );
}

function renderInline(tokens: Inline[]): ReactNode[] {
  return tokens.map((t, i) => {
    switch (t.t) {
      case 'code':
        return <code key={i} className={styles.inlineCode}>{t.v}</code>;
      case 'bold':
        return <strong key={i}>{renderInline(t.c)}</strong>;
      case 'italic':
        return <em key={i}>{renderInline(t.c)}</em>;
      case 'color':
        return (
          <span key={i} className={styles.colorChip} style={{ background: t.bg, color: t.fg }} title={t.v}>
            {t.v}
          </span>
        );
      case 'media':
        return <InlineMedia key={i} name={t.name} alt={t.alt} from={t.taskId} />;
      case 'file':
        return <FileLink key={i} name={t.name} label={t.label} from={t.taskId} />;
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
