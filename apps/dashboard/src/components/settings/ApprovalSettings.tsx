import { useEffect, useState } from 'react';
import { useAction } from '@/lib/use-settings-resource';
import { api } from '@/lib/api';
import { Card, ErrorText, Muted, SectionTitle } from '@/components/ui';

/** Settings → Work → Approvals: ask before a risky action (default), or let the agents work without cards. */
export function ApprovalSettings() {
  const [off, setOff] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const { busy, msg, setMsg, run } = useAction();

  useEffect(() => {
    void api
      .getApprovalMode()
      .then((r) => {
        setOff(r.mode === 'off');
        setLoaded(true);
      })
      .catch((e) => setMsg({ ok: false, text: (e as Error).message }));
  }, []);

  const change = (next: boolean) =>
    run(async () => {
      const r = await api.setApprovalMode(next ? 'off' : 'ask');
      setOff(r.mode === 'off');
      return r.mode === 'off' ? 'Approvals are off: agents run risky actions without asking.' : 'Approvals are on again.';
    });

  return (
    <Card>
      <SectionTitle>Approvals</SectionTitle>
      <Muted>
        By default an agent asks before a risky action — a dangerous shell command, a write outside its folders, a call to an outside service, a push. Work in its own folder and in /tmp never asks.
        This is the <strong>global</strong> level. A <strong>project</strong> (its settings) and a <strong>task</strong> (the 🛡 selector on its page; its subtasks follow it) can override it, in either direction —
        the most specific level that is set wins.
      </Muted>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '10px 0' }}>
        <input type="checkbox" checked={off} disabled={busy || !loaded} onChange={(e) => void change(e.target.checked)} style={{ width: 'auto', margin: 0 }} /> No approvals mode — do not ask
      </label>
      {off && (
        <Muted>
          ⚠ On: shell commands, outside calls, git push and starting tasks go ahead without a card, on every project that does not set its own level. Still asked even now: a merge (git merge, a pull request merge), any action on the main / master branch
          (a push, checkout, reset, delete …), anything outside the working directory (a write, move or delete beyond the project folder), touching sign-in passwords / tokens / the charter and CI files, and everything the admin changes on the platform (settings, providers, agents, updates). Runs that reach the step limit or the time ceiling are continued by themselves (a run that keeps hitting the step limit without finishing is still stopped after a few rounds). Switch it back off when you are done.
        </Muted>
      )}
      {msg && (msg.ok ? <Muted>{msg.text}</Muted> : <ErrorText>{msg.text}</ErrorText>)}
    </Card>
  );
}
