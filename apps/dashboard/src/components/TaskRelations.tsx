'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, type AgentInfo, type TaskDetail } from '@/lib/api';
import { Card, SectionTitle, Row, Button, Field, Muted, ErrorText } from '@/components/ui';
import { StatusBadge } from '@/components/StatusBadge';
import styles from './TaskRelations.module.css';

/**
 * Parent link, subtasks (with an inline "add subtask" form), and referenced
 * tasks (with their summaries) for a task. Creating a subtask enqueues it and
 * refreshes the parent via onChange.
 */
export function TaskRelations({ task, onChange }: { task: TaskDetail; onChange: () => void }) {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [adding, setAdding] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [title, setTitle] = useState('');
  const [agentName, setAgentName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listAgents().then(setAgents).catch(() => undefined);
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.createSubtask(task.id, {
        prompt: prompt.trim(),
        title: title.trim() || undefined,
        agentName: agentName || undefined,
      });
      setPrompt('');
      setTitle('');
      setAgentName('');
      setAdding(false);
      onChange();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const summaryOf = (link: TaskDetail['linksOut'][number]) =>
    link.to.sessions[0]?.reportedSummary ?? `${link.to.title} (${link.to.status})`;

  return (
    <>
      {task.parent && (
        <Muted className={styles.parent}>
          ↑ subtask of <Link href={`/tasks/${task.parent.id}`}>{task.parent.title}</Link>{' '}
          <StatusBadge status={task.parent.status} />
        </Muted>
      )}

      <Card>
        <Row spaceBetween>
          <SectionTitle className={styles.flush}>Subtasks ({task.subtasks.length})</SectionTitle>
          <Button size="sm" onClick={() => setAdding((v) => !v)}>
            {adding ? 'Cancel' : '+ Subtask'}
          </Button>
        </Row>

        {task.subtasks.length === 0 && !adding && (
          <Muted className={styles.empty}>No subtasks. Decompose this task into independent units.</Muted>
        )}

        {task.subtasks.map((s) => (
          <div key={s.id} className={styles.item}>
            <Link href={`/tasks/${s.id}`} className={styles.itemTitle}>
              {s.title}
            </Link>
            <span className={styles.meta}>
              {s.agentName ?? 'default'} <StatusBadge status={s.status} />
            </span>
          </div>
        ))}

        {adding && (
          <form onSubmit={submit} className={styles.form}>
            <Field label="Subtask instruction">
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={3}
                placeholder="A full instruction for the subtask…"
              />
            </Field>
            <Row>
              <input
                className={styles.grow}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Title (optional)"
              />
              <select value={agentName} onChange={(e) => setAgentName(e.target.value)}>
                <option value="">default agent</option>
                {agents.map((a) => (
                  <option key={a.name} value={a.name}>
                    {a.name}
                  </option>
                ))}
              </select>
            </Row>
            <Row>
              <Button variant="primary" type="submit" disabled={busy || !prompt.trim()}>
                {busy ? 'Creating…' : 'Create subtask'}
              </Button>
              {error && <ErrorText>{error}</ErrorText>}
            </Row>
          </form>
        )}
      </Card>

      {task.linksOut.length > 0 && (
        <Card>
          <SectionTitle className={styles.flush}>References ({task.linksOut.length})</SectionTitle>
          <Muted className={styles.empty}>Summaries of these tasks are folded into this task&rsquo;s context.</Muted>
          {task.linksOut.map((link) => (
            <div key={link.toTaskId} className={styles.item}>
              <Link href={`/tasks/${link.toTaskId}`} className={styles.itemTitle}>
                {link.to.title}
              </Link>
              <span className={styles.summary}>{summaryOf(link)}</span>
            </div>
          ))}
        </Card>
      )}
    </>
  );
}
