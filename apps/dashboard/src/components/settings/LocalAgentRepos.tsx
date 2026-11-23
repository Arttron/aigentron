import { useEffect, useState } from 'react';
import { api, type LocalBindingView, type LocalRepo } from '@/lib/api';
import type { Project } from '@lds/shared';
import { Badge, Button, ErrorText, Muted, Row } from '@/components/ui';

type Device = { id: string; label: string; online: boolean; repos: LocalRepo[] };

const summary = (r: LocalRepo): string => {
  const bits = [r.detached ? `detached ${r.head}` : r.branch || '(no branch)'];
  if (r.upstream) bits.push(`${r.ahead} ahead, ${r.behind} behind`);
  const dirty = r.staged + r.unstaged + r.untracked;
  bits.push(dirty ? `${dirty} changed` : 'clean');
  if (r.conflicted) bits.push(`${r.conflicted} conflicted`);
  if (r.state) bits.push(`${r.state} in progress`);
  return bits.join(' · ');
};

/** Repositories the computers allowed (`aigentron add`), and which project each one is shared with. Read only for now: agents can look, not change. */
export function LocalAgentRepos({ devices, bindings, reload }: { devices: Device[]; bindings: LocalBindingView[]; reload: () => void }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [choice, setChoice] = useState<Record<string, string>>({}); // "<device>:<repo>" → project id
  useEffect(() => void api.listProjects().then(setProjects).catch(() => undefined), []);

  const withRepos = devices.filter((d) => d.repos.length > 0);
  const act = (p: Promise<unknown>) => void p.then(reload).catch((e: Error) => setError(e.message));

  return (
    <div style={{ margin: '14px 0' }}>
      <strong>Repositories on your computers</strong>
      <Muted>
        A computer allows a repository with <code>aigentron add &lt;path&gt;</code> (its top folder). Here you share it with a project: from then on that project&apos;s agents can <em>read</em> it — status, diff, history, files — and nothing else. They cannot change
        anything, and never see secret files (<code>.env</code>, keys, credentials, <code>.git</code>). If the project has a repository address, it works only while the repository&apos;s <code>origin</code> is that address; a project without one needs no match (your Share is the consent).
      </Muted>
      {error && <ErrorText>{error}</ErrorText>}
      {withRepos.length === 0 && <Muted>No repository yet. On a connected computer run: <code>aigentron add ~/Code/my-project</code></Muted>}
      {withRepos.map((d) => (
        <div key={d.id} style={{ margin: '8px 0' }}>
          <strong>{d.label}</strong> <Badge tone={d.online ? 'done' : 'neutral'}>{d.online ? 'online' : 'offline'}</Badge>
          <ul style={{ margin: '4px 0', paddingLeft: 18 }}>
            {d.repos.map((r) => {
              const mine = bindings.filter((b) => b.deviceId === d.id && b.repoId === r.id);
              const key = `${d.id}:${r.id}`;
              return (
                <li key={r.id}>
                  <code>{r.path}</code> — {summary(r)}
                  {r.error && <ErrorText>{r.error}</ErrorText>}
                  {r.files.length > 0 && (
                    <details>
                      <summary>{r.files.length}{r.filesCut ? '+' : ''} changed file(s)</summary>
                      <pre style={{ margin: 0 }}>{r.files.map((f) => `${f.xy.padEnd(2)} ${f.path}`).join('\n')}</pre>
                    </details>
                  )}
                  {mine.map((b) => (
                    <Row key={b.id} wrap>
                      <Badge tone={b.valid ? 'done' : 'review'}>{b.valid ? 'shared' : 'not usable'}</Badge> with <strong>{b.projectName}</strong>
                      {b.reason && <Muted>— {b.reason}</Muted>}
                      <Button size="sm" onClick={() => act(api.localAgentUnbind(b.id))}>
                        Stop sharing
                      </Button>
                    </Row>
                  ))}
                  <Row wrap>
                    <select value={choice[key] ?? ''} onChange={(e) => setChoice({ ...choice, [key]: e.target.value })}>
                      <option value="">Share with a project…</option>
                      {projects.filter((p) => !mine.some((b) => b.projectId === p.id)).map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                    <Button size="sm" disabled={!choice[key]} onClick={() => act(api.localAgentBind({ projectId: choice[key]!, deviceId: d.id, repoId: r.id }).then(() => setChoice({ ...choice, [key]: '' })))}>
                      Share (read only)
                    </Button>
                  </Row>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      {bindings.filter((b) => !devices.some((d) => d.id === b.deviceId && d.repos.some((r) => r.id === b.repoId))).map((b) => (
        <Row key={b.id} wrap>
          <Badge tone="review">not usable</Badge> {b.projectName} ← {b.repoPath ?? b.repoId} on {b.deviceLabel} <Muted>— {b.reason}</Muted>
          <Button size="sm" onClick={() => act(api.localAgentUnbind(b.id))}>
            Remove
          </Button>
        </Row>
      ))}
    </div>
  );
}
