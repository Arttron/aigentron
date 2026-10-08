import { useCallback, useEffect, useState } from 'react';
import { api, type PackInfo, type PackInstallResult } from '@/lib/api';
import { Button, Card, ErrorText, Muted, SectionTitle } from '@/components/ui';
import styles from './PacksCard.module.css';

const localTz = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

/** Ready-made sets of agents, skills, library notes and (switched-off) schedules for a kind of project. */
export function PacksCard() {
  const [packs, setPacks] = useState<PackInfo[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<Record<string, PackInstallResult>>({});
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setPacks(await api.listPacks());
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const install = async (p: PackInfo) => {
    setBusy(p.name);
    setError(null);
    try {
      const r = await api.installPack(p.name, localTz());
      setDone((d) => ({ ...d, [p.name]: r }));
      await refresh();
    } catch (e) {
      setError((e as Error).message.replace(/^\d+ [^—]*— /, ''));
    } finally {
      setBusy(null);
    }
  };

  if (!packs.length) return null;
  return (
    <Card>
      <SectionTitle>Starter packs</SectionTitle>
      <Muted>
        Ready-made teams for a kind of project: agents, skills, starter notes in the library and prepared reminders (they start switched off). Installing never
        overwrites anything you already have. You can also ask the admin: "set me up for learning English".
      </Muted>
      {error && <ErrorText>{error}</ErrorText>}
      {packs.map((p) => {
        const all = p.installed.agents === p.total.agents && p.installed.skills === p.total.skills && p.installed.resources === p.total.resources && p.installed.schedules === p.total.schedules;
        const r = done[p.name];
        return (
          <div key={p.name} className={styles.pack}>
            <div className={styles.head}>
              <span className={styles.icon} aria-hidden>
                {p.icon ?? '📦'}
              </span>
              <div className={styles.titles}>
                <strong>{p.title}</strong>
                <span className={styles.audience}>{p.audience}</span>
              </div>
              <span className={all ? styles.on : styles.state}>{all ? 'installed' : p.installed.agents + p.installed.resources + p.installed.skills + p.installed.schedules > 0 ? 'partly installed' : ''}</span>
            </div>
            <div className={styles.desc}>{p.description}</div>
            <div className={styles.facts}>
              <span>
                🤖 {p.total.agents} agents: {[...(p.agents ?? []), ...(p.catalogAgents ?? [])].join(', ')}
              </span>
              <span>📚 {p.total.resources} library notes</span>
              <span>⏰ {p.total.schedules} prepared schedules (off)</span>
            </div>
            <div className={styles.buttons}>
              <Button variant={all ? 'default' : 'primary'} disabled={busy !== null} onClick={() => install(p)}>
                {busy === p.name ? 'Installing…' : all ? 'Install again (fills gaps)' : 'Install'}
              </Button>
              <Button onClick={() => setOpen(open === p.name ? null : p.name)}>{open === p.name ? 'Hide details' : 'What is inside'}</Button>
            </div>
            {open === p.name && (
              <pre className={styles.details}>
                {[
                  ...(p.resources ?? []).map((x) => `📚 ${x.title} — ${x.description ?? ''}`),
                  ...(p.schedules ?? []).map((x) => `⏰ ${x.name} (${x.cron}) → ${x.agent}`),
                  p.after ? `\nNext steps: ${p.after}` : '',
                ].join('\n')}
              </pre>
            )}
            {r && <pre className={styles.result}>{r.summary}</pre>}
          </div>
        );
      })}
    </Card>
  );
}
