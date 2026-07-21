'use client';

import { useEffect, useMemo, useState } from 'react';
import type { ProviderUsage, UsageReport } from '@lds/shared';
import { api } from '@/lib/api';
import { AppHeader, BackLink, Button, Card, SectionTitle, Muted, ErrorText } from '@/components/ui';
import { cn } from '@/lib/cn';
import { UsageChart } from './UsageChart';
import styles from './page.module.css';

type RangeKey = 'today' | '7d' | '30d' | 'all';
const RANGES: { key: RangeKey; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: '7d', label: '7 days' },
  { key: '30d', label: '30 days' },
  { key: 'all', label: 'All time' },
];

/** Start of the selected range as an ISO string (undefined = unbounded). */
function fromFor(r: RangeKey): string | undefined {
  if (r === 'all') return undefined;
  const d = new Date();
  if (r === 'today') d.setHours(0, 0, 0, 0);
  else d.setDate(d.getDate() - (r === '7d' ? 7 : 30));
  return d.toISOString();
}

type ColKey = keyof ProviderUsage;
const COLS: { key: ColKey; label: string; num: boolean }[] = [
  { key: 'provider', label: 'Provider', num: false },
  { key: 'sessions', label: 'Sessions', num: true },
  { key: 'requests', label: 'Requests', num: true },
  { key: 'inputTokens', label: 'Input', num: true },
  { key: 'outputTokens', label: 'Output', num: true },
  { key: 'cacheTokens', label: 'Cache', num: true },
  { key: 'estCostUsd', label: 'Est. cost', num: true },
];

const NF = new Intl.NumberFormat();
const fmtInt = (n: number) => NF.format(n);
/** Est. cost: 0 → em dash (LiteLLM reports none); tiny values keep more digits. */
const fmtCost = (n: number) => (n === 0 ? '—' : `$${n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`);
const cell = (key: ColKey, v: number) => (key === 'estCostUsd' ? fmtCost(v) : fmtInt(v));

export default function StatsPage() {
  const [range, setRange] = useState<RangeKey>('7d');
  const [data, setData] = useState<UsageReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sort, setSort] = useState<{ key: ColKey; dir: 'asc' | 'desc' }>({
    key: 'requests',
    dir: 'desc',
  });

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    api
      .getUsage({ from: fromFor(range) })
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError((e as Error).message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [range]);

  const rows = useMemo(() => {
    if (!data) return [];
    return [...data.providers].sort((a, b) => {
      const av = a[sort.key];
      const bv = b[sort.key];
      const cmp =
        typeof av === 'number' && typeof bv === 'number'
          ? av - bv
          : String(av).localeCompare(String(bv));
      return sort.dir === 'asc' ? cmp : -cmp;
    });
  }, [data, sort]);

  function toggleSort(key: ColKey) {
    setSort((s) =>
      s.key === key
        ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: key === 'provider' ? 'asc' : 'desc' },
    );
  }

  return (
    <>
      <BackLink href="/">← all tasks</BackLink>
      <AppHeader title="📊 Usage stats" />

      <Card>
        <SectionTitle>Usage by provider</SectionTitle>
        <div className={styles.controls}>
          {RANGES.map((r) => (
            <Button
              key={r.key}
              size="sm"
              variant={range === r.key ? 'primary' : 'default'}
              onClick={() => setRange(r.key)}
            >
              {r.label}
            </Button>
          ))}
        </div>

        {error && (
          <>
            <ErrorText>Couldn&apos;t load usage stats just now.</ErrorText>
            <Muted className={styles.note}>{error}</Muted>
          </>
        )}
        {loading && !data && <Muted className={styles.empty}>Crunching the numbers…</Muted>}
        {data && rows.length === 0 && !loading && (
          <Muted className={styles.empty}>
            Nothing here yet for this range — try a wider window like 30 days or All time.
          </Muted>
        )}

        {data && data.providers.length > 0 && <UsageChart providers={data.providers} />}

        {data && rows.length > 0 && (
          <table className={styles.table}>
            <thead>
              <tr>
                {COLS.map((c) => (
                  <th
                    key={c.key}
                    className={cn(styles.th, c.num && styles.num)}
                    onClick={() => toggleSort(c.key)}
                    aria-sort={
                      sort.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'
                    }
                  >
                    {c.label}
                    {sort.key === c.key && (
                      <span className={styles.arrow}>{sort.dir === 'asc' ? '▲' : '▼'}</span>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.provider}>
                  {COLS.map((c) => (
                    <td
                      key={c.key}
                      className={cn(c.num && styles.num, c.key === 'estCostUsd' && styles.cost)}
                    >
                      {c.key === 'provider' ? p.provider : cell(c.key, p[c.key] as number)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className={styles.totals}>
                <td>Total</td>
                {COLS.slice(1).map((c) => (
                  <td key={c.key} className={cn(styles.num, c.key === 'estCostUsd' && styles.cost)}>
                    {cell(c.key, data.totals[c.key as keyof typeof data.totals])}
                  </td>
                ))}
              </tr>
            </tfoot>
          </table>
        )}

        <Muted className={styles.note}>
          A few notes: <strong>Requests</strong> counts each agentic turn the fleet took.{' '}
          <strong>Est. cost</strong> is a best-effort estimate — right on the money for Anthropic,
          rough or zero for models routed through LiteLLM. And runs from before usage tracking was
          switched on simply show as 0 here — nothing&apos;s missing.
        </Muted>
      </Card>
    </>
  );
}
