import { useEffect, useMemo, useState } from 'react';
import type { ProviderUsage, UsageReport } from '@lds/shared';
import { api } from '@/lib/api';
import { useProjects } from '@/lib/use-projects';
import { STAT_COLS, dayLabel, readHidden, writeHidden, type StatCol } from '@/lib/stats-view';
import { AppHeader, BackLink, Button, Card, SectionTitle, Muted, ErrorText } from '@/components/ui';
import { cn } from '@/lib/cn';
import { UsageChart } from './UsageChart';
import { DailyChart } from './DailyChart';
import styles from './StatsPage.module.css';

type RangeKey = 'today' | '7d' | '30d' | 'all';
const RANGES: { key: RangeKey; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: '7d', label: '7 days' },
  { key: '30d', label: '30 days' },
  { key: 'all', label: 'All time' },
];

type View = 'provider' | 'project' | 'day';
const VIEWS: { key: View; label: string }[] = [
  { key: 'provider', label: 'By provider' },
  { key: 'project', label: 'By project' },
  { key: 'day', label: 'By day' },
];

/** Start of the selected range as an ISO string (undefined = unbounded). */
function fromFor(r: RangeKey): string | undefined {
  if (r === 'all') return undefined;
  const d = new Date();
  if (r === 'today') d.setHours(0, 0, 0, 0);
  else d.setDate(d.getDate() - (r === '7d' ? 7 : 30));
  return d.toISOString();
}

const NF = new Intl.NumberFormat();
const fmtInt = (n: number) => NF.format(n);
/** Est. cost: 0 → em dash (LiteLLM reports none); tiny values keep more digits. */
const fmtCost = (n: number) => (n === 0 ? '—' : `$${n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`);
const cell = (key: StatCol, v: number) => (key === 'estCostUsd' ? fmtCost(v) : fmtInt(v));

type Totals = Omit<ProviderUsage, 'provider'>;
interface Row {
  id: string;
  label: string;
  /** a project row can be picked as the project of the page */
  pick?: string;
  totals: Totals;
}

export function StatsPage() {
  const [range, setRange] = useState<RangeKey>('7d');
  const [view, setView] = useState<View>('provider');
  const [project, setProject] = useState<string>(() => new URLSearchParams(window.location.search).get('project') ?? '');
  const [hidden, setHidden] = useState<Set<StatCol>>(readHidden);
  const [data, setData] = useState<UsageReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sort, setSort] = useState<{ key: StatCol | 'label'; dir: 'asc' | 'desc' }>({ key: 'requests', dir: 'desc' });
  const { projects } = useProjects();

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    api
      .getUsage({ from: fromFor(range), project: project || undefined })
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError((e as Error).message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [range, project]);

  const toggleCol = (c: StatCol) =>
    setHidden((h) => {
      const next = new Set(h);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      writeHidden(next);
      return next;
    });

  const cols = STAT_COLS.filter((c) => !hidden.has(c.key));

  // the rows of the table of the chosen view
  const rows: Row[] = useMemo(() => {
    if (!data) return [];
    const list: Row[] =
      view === 'provider'
        ? data.providers.map((p) => ({ id: p.provider, label: p.provider, totals: p }))
        : view === 'project'
          ? (data.projects ?? []).map((p) => ({ id: p.slug, label: p.name, pick: p.slug, totals: p.totals }))
          : [...(data.days ?? [])].reverse().map((d) => ({ id: d.date, label: dayLabel(d.date), totals: d.totals }));
    if (view === 'day' && sort.key === 'label') return list; // newest first, as built
    return [...list].sort((a, b) => {
      const cmp = sort.key === 'label' ? a.label.localeCompare(b.label) : a.totals[sort.key] - b.totals[sort.key];
      return sort.dir === 'asc' ? cmp : -cmp;
    });
  }, [data, view, sort]);

  function toggleSort(key: StatCol | 'label') {
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'label' ? 'asc' : 'desc' }));
  }

  const firstHeader = view === 'provider' ? 'Provider' : view === 'project' ? 'Project' : 'Day';
  const projectName = projects?.find((p) => p.slug === project)?.name ?? project;
  const hasUsage = data !== null && data.totals.sessions > 0;

  return (
    <>
      <BackLink href="/">← all tasks</BackLink>
      <AppHeader title="📊 Usage stats" />

      <Card>
        <SectionTitle>Usage{project ? ` of ${projectName}` : ''}</SectionTitle>
        <div className={styles.controls}>
          {RANGES.map((r) => (
            <Button key={r.key} size="sm" variant={range === r.key ? 'primary' : 'default'} onClick={() => setRange(r.key)}>
              {r.label}
            </Button>
          ))}
          <span className={styles.sep} />
          {VIEWS.map((v) => (
            <Button key={v.key} size="sm" variant={view === v.key ? 'primary' : 'default'} onClick={() => { setView(v.key); setSort(v.key === 'day' ? { key: 'label', dir: 'desc' } : { key: 'requests', dir: 'desc' }); }}>
              {v.label}
            </Button>
          ))}
          {(projects?.length ?? 0) > 1 && (
            <select aria-label="Project" value={project} onChange={(e) => setProject(e.target.value)} className={styles.projectSelect} title="Limit the numbers to one project">
              <option value="">All projects</option>
              {(projects ?? []).filter((p) => !p.archivedAt || p.slug === project).map((p) => (
                <option key={p.slug} value={p.slug}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className={styles.show} role="group" aria-label="Columns to show">
          <Muted>Show:</Muted>
          {STAT_COLS.map((c) => (
            <label key={c.key} className={styles.showItem}>
              <input type="checkbox" checked={!hidden.has(c.key)} onChange={() => toggleCol(c.key)} /> {c.label}
            </label>
          ))}
        </div>

        {error && (
          <>
            <ErrorText>Couldn&apos;t load usage stats just now.</ErrorText>
            <Muted className={styles.note}>{error}</Muted>
          </>
        )}
        {loading && !data && <Muted className={styles.empty}>Crunching the numbers…</Muted>}
        {data && !hasUsage && !loading && <Muted className={styles.empty}>Nothing here yet for this range{project ? ' and project' : ''} — try a wider window like 30 days or All time.</Muted>}

        {hasUsage && view === 'provider' && <UsageChart providers={data.providers} hidden={hidden} />}
        {hasUsage && view === 'day' && <DailyChart days={(data.days ?? []).slice(-120)} hidden={hidden} />}

        {hasUsage && cols.length === 0 && <Muted className={styles.empty}>Every column is switched off — tick some above.</Muted>}
        {hasUsage && cols.length > 0 && rows.length > 0 && (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.th} onClick={() => toggleSort('label')} aria-sort={sort.key === 'label' ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                    {firstHeader}
                    {sort.key === 'label' && <span className={styles.arrow}>{sort.dir === 'asc' ? '▲' : '▼'}</span>}
                  </th>
                  {cols.map((c) => (
                    <th key={c.key} className={cn(styles.th, styles.num)} onClick={() => toggleSort(c.key)} aria-sort={sort.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                      {c.label}
                      {sort.key === c.key && <span className={styles.arrow}>{sort.dir === 'asc' ? '▲' : '▼'}</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      {r.pick !== undefined ? (
                        <button type="button" className={styles.link} onClick={() => { setProject(r.pick!); setView('provider'); }} title="Show this project by provider">
                          {r.label}
                        </button>
                      ) : (
                        r.label
                      )}
                    </td>
                    {cols.map((c) => (
                      <td key={c.key} className={cn(styles.num, c.key === 'estCostUsd' && styles.cost)}>
                        {cell(c.key, r.totals[c.key])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className={styles.totals}>
                  <td>Total</td>
                  {cols.map((c) => (
                    <td key={c.key} className={cn(styles.num, c.key === 'estCostUsd' && styles.cost)}>
                      {cell(c.key, data.totals[c.key])}
                    </td>
                  ))}
                </tr>
              </tfoot>
            </table>
          </div>
        )}

        <Muted className={styles.note}>
          A few notes: <strong>Requests</strong> counts each agentic turn the fleet took. <strong>Est. cost</strong> is a best-effort estimate — right on the money for Anthropic, rough or zero for models routed
          through LiteLLM. A run counts on the day it started, in your time zone. Runs from before usage tracking was switched on simply show as 0 here — nothing&apos;s missing. Cost and token totals from before
          0.1.60 are overstated for tasks with follow-ups; sessions that began before that update are counted from it on.
        </Muted>
      </Card>
    </>
  );
}
