import { useEffect, useState } from 'react';
import { api, type AgentInfo } from '@/lib/api';
import { Modal, Button, Row, Field, Muted, ErrorText, CheckboxGroup } from '@/components/ui';

/** Start a round-table: pick the agents, the topic and how long they talk; they answer each other in this chat. */
export function DiscussionModal({ taskId, initialTopic, onClose, onStarted }: { taskId?: string; initialTopic?: string; onClose: () => void; onStarted: (taskId: string) => void }) {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [topic, setTopic] = useState(initialTopic ?? '');
  const [rounds, setRounds] = useState(3);
  const [summaryBy, setSummaryBy] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listAgents()
      .then((a) => setAgents(a.filter((x) => x.name.toLowerCase() !== 'admin')))
      .catch((e) => setError((e as Error).message));
  }, []);

  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.startDiscussion({ taskId, topic, agents: picked, rounds, summaryBy: summaryBy || null });
      onStarted(r.taskId);
      onClose();
    } catch (e) {
      setError((e as Error).message.replace(/^\d+ [^—]*— /, ''));
      setBusy(false);
    }
  };

  const turns = picked.length * rounds;
  return (
    <Modal title="💬 Discussion between agents" onClose={onClose}>
      <Muted>
        The chosen agents answer each other, one after another, right in this chat. You can join in at any moment, press “Wrap up” for the conclusion, or stop it. Each turn is one short
        reply (it costs one model call).
      </Muted>
      <Field label="Topic — what should they discuss?">
        <textarea rows={3} value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="Should we rewrite the app in a new framework this quarter?" autoFocus />
      </Field>
      <Field label="Who takes part (2–6)">
        <CheckboxGroup options={agents.map((a) => a.name)} selected={picked} onChange={setPicked} empty="Create at least two agents first (Agents page)." />
      </Field>
      <Row wrap>
        <Field label="Rounds">
          <select value={rounds} onChange={(e) => setRounds(Number(e.target.value))}>
            {[1, 2, 3, 4, 5, 6].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Conclusion by">
          <select value={summaryBy} onChange={(e) => setSummaryBy(e.target.value)}>
            <option value="">— none —</option>
            {picked.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </Field>
      </Row>
      {picked.length >= 2 && <Muted>{turns} reply(ies) in total{summaryBy ? ' + the conclusion' : ''}. They may stop earlier if everyone agrees.</Muted>}
      {error && <ErrorText>{error}</ErrorText>}
      <Row>
        <Button variant="primary" disabled={busy || picked.length < 2 || !topic.trim()} onClick={go}>
          {busy ? 'Starting…' : 'Start the discussion'}
        </Button>
        <Button onClick={onClose}>Cancel</Button>
      </Row>
    </Modal>
  );
}
