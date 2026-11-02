import { useEffect, useState } from 'react';
import { parseEscalationStep } from '@lds/shared';
import { api } from '@/lib/api';
import { useAction } from '@/lib/use-settings-resource';
import { Button, Card, ErrorText, Muted, Row, SectionTitle } from '@/components/ui';
import { ModelStep } from '@/components/agents/EscalationEditor';

/** Settings → Work → Questions: the (cheap) model that answers tasks started as “Just a question” / `/ask`. */
export function AskModelSettings() {
  const [saved, setSaved] = useState<string | null>(null);
  const [value, setValue] = useState('');
  const [providers, setProviders] = useState<string[]>([]);
  const { busy, msg, setMsg, run } = useAction();

  useEffect(() => {
    void Promise.all([api.getSettings(), api.listProviders()])
      .then(([s, p]) => {
        setSaved(s.askModel ?? '');
        setValue(s.askModel ?? '');
        setProviders(p.map((x) => x.name));
      })
      .catch((e) => setMsg({ ok: false, text: (e as Error).message }));
  }, []);

  if (saved === null) return msg && !msg.ok ? <ErrorText>{msg.text}</ErrorText> : null;
  const complete = !value || Boolean(parseEscalationStep(value));
  const dirty = value !== saved;
  const save = () =>
    run(async () => {
      const r = await api.updateSettings({ askModel: value });
      setSaved(r.askModel ?? '');
      setValue(r.askModel ?? '');
      return value ? 'Saved — questions now use this model.' : 'Saved — questions use each agent’s own model.';
    });

  return (
    <Card>
      <SectionTitle>Questions</SectionTitle>
      <Muted>
        A task started as “Just a question” (or <code>/ask</code> in a chat) gets a light run: no working copy, no checks, no status report, and its own lane so it never waits behind long work. Choose a cheap model for
        them here; empty means each agent&apos;s own model. A model pinned for one task (a chat&apos;s <code>/model</code>) wins. If the agent has an escalation ladder, a question the cheap model could not answer climbs it.
      </Muted>
      <ModelStep value={value} providers={providers} onChange={setValue} />
      <Row wrap>
        <Button variant={dirty ? 'primary' : undefined} disabled={busy || !dirty || !complete} onClick={save}>
          Save
        </Button>
        <Button disabled={busy || !value} onClick={() => setValue('')}>
          Use each agent&apos;s own model
        </Button>
      </Row>
      {dirty && <Muted>● Not saved yet.</Muted>}
      {msg && (msg.ok ? <Muted>{msg.text}</Muted> : <ErrorText>{msg.text}</ErrorText>)}
    </Card>
  );
}
