import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { AgentQuestion } from '@lds/shared';
import { api } from '@/lib/api';
import { Button, ErrorText, Muted } from '@/components/ui';
import styles from './QuestionCard.module.css';

/** A question an agent asked (ask_user): answer buttons, plus a text box when the person may answer in their own words. */
export function QuestionCard({ question, showTask, onGone }: { question: AgentQuestion; showTask?: boolean; onGone?: () => void }) {
  const [text, setText] = useState('');
  const [picked, setPicked] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async (answer: { index?: number; indexes?: number[]; text?: string }) => {
    setBusy(true);
    setError(null);
    try {
      await api.answerQuestion(question.id, answer);
      onGone?.();
    } catch (e) {
      setError((e as Error).message);
      // somebody answered from elsewhere (a chat) — the card is stale
      if (/already/i.test((e as Error).message)) onGone?.();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.card}>
      {showTask && (
        <Link className={styles.task} to={`/tasks/${question.taskId}`}>
          ❓ task {question.taskId.slice(0, 8)}…
        </Link>
      )}
      {question.image && <img className={styles.image} src={api.questionImageUrl(question.id)} alt="" />}
      <div className={styles.text}>{question.question}</div>
      {question.options.length > 0 && (
        <div className={styles.options}>
          {question.options.map((o, i) =>
            question.multiple ? (
              <Button
                key={`${i}-${o}`}
                variant={picked.includes(i) ? 'primary' : undefined}
                disabled={busy}
                aria-pressed={picked.includes(i)}
                onClick={() => setPicked((p) => (p.includes(i) ? p.filter((x) => x !== i) : [...p, i]))}
              >
                {picked.includes(i) ? '☑' : '☐'} {o}
              </Button>
            ) : (
              <Button key={`${i}-${o}`} disabled={busy} onClick={() => void send({ index: i })}>
                {o}
              </Button>
            ),
          )}
          {question.multiple && (
            <Button variant="primary" disabled={busy || picked.length === 0} onClick={() => void send({ indexes: picked })}>
              Send{picked.length ? ` (${picked.length})` : ''}
            </Button>
          )}
        </div>
      )}
      {(question.allowText || question.options.length === 0) && (
        <form
          className={styles.own}
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) void send({ text });
          }}
        >
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder={question.options.length ? 'Or write your own answer…' : 'Your answer…'} disabled={busy} />
          <Button variant="primary" type="submit" disabled={busy || !text.trim()}>
            Send
          </Button>
        </form>
      )}
      {error && <ErrorText>{error}</ErrorText>}
      <Muted className={styles.hint}>The agent is waiting for this. You can also answer from a chat channel.</Muted>
    </div>
  );
}
