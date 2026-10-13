import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { formatBytes } from '@/lib/format-bytes';
import { Button, Card, ErrorText, Muted, Row, SectionTitle } from '@/components/ui';

type Disk = Awaited<ReturnType<typeof api.diskStatus>>;
type Report = Awaited<ReturnType<typeof api.maintenanceReport>>;

/** Settings → General → Disk & cleanup: free space, what takes it, and the safe "free space now" action. */
export function DiskSettings() {
  const [disk, setDisk] = useState<Disk>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = () => {
    void api.diskStatus().then(setDisk).catch(() => undefined);
    void api.maintenanceReport().then(setReport).catch((e) => setMsg({ ok: false, text: (e as Error).message }));
  };
  useEffect(load, []);

  const relieve = async () => {
    if (!window.confirm('Delete the regenerable caches now (all video digests, fetched web pages older than 30 days, run folders older than 3 days)? Your files, tasks and notes are not touched.')) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.relieveDisk();
      setMsg({ ok: true, text: `Freed ${formatBytes(r.bytes)}: ${r.digests} video digest(s), ${r.research} cached page(s), ${r.runs} run folder(s).` });
      load();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const used = disk ? disk.usedPercent : 0;
  const color = disk?.level === 'critical' ? 'var(--red, #c0392b)' : disk?.level === 'warn' ? 'var(--amber, #a8781f)' : 'var(--accent)';
  return (
    <Card>
      <SectionTitle>Disk &amp; cleanup</SectionTitle>
      {disk ? (
        <>
          <div style={{ height: 10, borderRadius: 6, background: 'var(--bg)', boxShadow: 'var(--inset-sm)', overflow: 'hidden', margin: '6px 0' }} aria-hidden>
            <div style={{ width: `${used}%`, height: '100%', background: color }} />
          </div>
          <Muted>
            {formatBytes(disk.freeBytes)} free of {formatBytes(disk.totalBytes)} ({100 - used}% free) —{' '}
            {disk.level === 'ok' ? 'fine' : disk.level === 'warn' ? 'running low' : 'critically low'}. Checked every 10 minutes; a warning appears here, at the top of the page and in your chat when it gets low (under{' '}
            {formatBytes(disk.warnBelowBytes)}), and the caches are cleared automatically when it becomes critical (under {formatBytes(disk.criticalBelowBytes)}).
          </Muted>
        </>
      ) : (
        <Muted>The free space could not be read on this server.</Muted>
      )}
      {report && (
        <ul style={{ margin: '10px 0', paddingLeft: 18, fontSize: 13 }}>
          <li>
            Task attachments: {formatBytes(report.attachments.bytes)}
            {report.attachments.oldTasksBytes > 0 && ` — ${formatBytes(report.attachments.oldTasksBytes)} belong to tasks finished over 90 days ago (your files: delete those tasks yourself if you do not need them)`}
          </li>
          <li>
            Video digests (cache): {report.caches.digests.count} · {formatBytes(report.caches.digests.bytes)} — removed automatically after {report.caches.digestRetentionDays} days
          </li>
          <li>
            Fetched web pages (cache): {report.caches.research.count} · {formatBytes(report.caches.research.bytes)} — removed automatically after {report.caches.researchRetentionDays} days
          </li>
          <li>
            Agent run folders: {report.runs.count} · {formatBytes(report.runs.bytes)} — removed automatically after {report.retentionDays} days
          </li>
          <li>Resource library: {formatBytes(report.resources.bytes)}</li>
          <li>Shared workspace (memory, work, deliverables): {formatBytes(report.workspace?.bytes ?? 0)} — never cleaned automatically</li>
          {report.worktrees.count > 0 && (
            <li>
              Old git worktrees: {report.worktrees.count} · {formatBytes(report.worktrees.bytes)} (cleaned only on request — ask the admin)
            </li>
          )}
        </ul>
      )}
      <Row wrap>
        <Button disabled={busy} onClick={relieve}>
          Free up space now
        </Button>
        <Button disabled={busy} onClick={load}>
          Refresh
        </Button>
      </Row>
      {msg && (msg.ok ? <Muted>{msg.text}</Muted> : <ErrorText>{msg.text}</ErrorText>)}
    </Card>
  );
}
