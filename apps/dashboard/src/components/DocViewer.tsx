import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { docKind, parseDelimited, type DocKind } from '@/lib/doc-kinds';
import { Modal, Muted, ErrorText, Button, Row } from '@/components/ui';
import { Markdown, MediaTaskContext } from './Markdown';
import styles from './DocViewer.module.css';

const MAX_CHARS = 400_000;
const MAX_ROWS = 500;

/** A document of a task opened in the page: Markdown rendered, HTML in a sandbox (no scripts), CSV as a table, JSON pretty-printed, text as is, PDF in a frame. */
export function DocViewer({ taskId, name, onClose }: { taskId: string; name: string; onClose: () => void }) {
  const kind = docKind(name) as DocKind;
  const url = api.attachmentUrl(taskId, name);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [raw, setRaw] = useState(false);

  useEffect(() => {
    if (kind === 'pdf') return;
    const ctl = new AbortController();
    fetch(url, { signal: ctl.signal })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`${r.status} ${r.statusText}`))))
      .then(setText)
      .catch((e: Error) => e.name !== 'AbortError' && setError(e.message));
    return () => ctl.abort();
  }, [url, kind]);

  const cut = text !== null && text.length > MAX_CHARS;
  const body = text === null ? '' : cut ? text.slice(0, MAX_CHARS) : text;
  const label = name.replace(/^task:[\w-]+\//, '');

  let view: React.ReactNode = null;
  if (kind === 'pdf') view = <iframe className={styles.frame} src={url} title={label} />;
  else if (text !== null) {
    if (raw) view = <pre className={styles.pre}>{body}</pre>;
    else if (kind === 'md')
      view = (
        <div className={styles.md}>
          <MediaTaskContext.Provider value={taskId}>
            <Markdown text={body} />
          </MediaTaskContext.Provider>
        </div>
      );
    else if (kind === 'html') view = <iframe className={styles.frame} sandbox="" srcDoc={body} title={label} />;
    else if (kind === 'csv') {
      const rows = parseDelimited(body, /\.tsv$/i.test(name) ? '\t' : ',');
      const shown = rows.slice(0, MAX_ROWS);
      view = (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>{(shown[0] ?? []).map((c, i) => <th key={i}>{c}</th>)}</tr>
            </thead>
            <tbody>
              {shown.slice(1).map((r, i) => (
                <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>
              ))}
            </tbody>
          </table>
          {rows.length > MAX_ROWS && <Muted>First {MAX_ROWS} of {rows.length} rows.</Muted>}
        </div>
      );
    } else if (kind === 'json') {
      let pretty = body;
      try {
        pretty = JSON.stringify(JSON.parse(body), null, 2);
      } catch {
        /* not valid JSON — shown as it is */
      }
      view = <pre className={styles.pre}>{pretty}</pre>;
    } else view = <pre className={styles.pre}>{body}</pre>;
  }

  return (
    <Modal title={label} onClose={onClose} wide>
      <Row className={styles.bar}>
        {(kind === 'md' || kind === 'html') && (
          <Button size="sm" onClick={() => setRaw((r) => !r)}>
            {raw ? 'Rendered' : 'Source'}
          </Button>
        )}
        {text !== null && (
          <Button size="sm" onClick={() => void navigator.clipboard?.writeText(text)}>
            Copy
          </Button>
        )}
        <a href={url} target="_blank" rel="noreferrer" download={label} className={styles.link}>
          Download
        </a>
      </Row>
      {error && <ErrorText>Could not open the file: {error}</ErrorText>}
      {!error && text === null && kind !== 'pdf' && <Muted>Loading…</Muted>}
      {cut && <Muted>Showing the first {MAX_CHARS.toLocaleString()} characters — download the file for the rest.</Muted>}
      {kind === 'html' && !raw && <Muted>Shown safely: scripts and forms are disabled.</Muted>}
      {view}
    </Modal>
  );
}
