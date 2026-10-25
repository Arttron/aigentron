import { useState } from 'react';
import type { DayUsage } from '@lds/shared';
import { axisTicks, dayLabel, shownTokens, type StatCol } from '@/lib/stats-view';
import { Muted } from '@/components/ui';
import styles from './DailyChart.module.css';

const NF = new Intl.NumberFormat();
const SERIES = [
  { key: 'inputTokens', label: 'Input', color: 'var(--viz-input)' },
  { key: 'outputTokens', label: 'Output', color: 'var(--viz-output)' },
  { key: 'cacheTokens', label: 'Cache', color: 'var(--viz-cache)' },
] as const;

/** Tokens per day as columns, stacked Input / Output / Cache (the series that are switched off drop out of the columns). Quiet days are empty slots. */
export function DailyChart({ days, hidden }: { days: DayUsage[]; hidden: ReadonlySet<StatCol> }) {
  const [tip, setTip] = useState<{ x: number; y: number; day: string; lines: string[] } | null>(null);
  const totals = days.map((d) => shownTokens(d.totals, hidden));
  const max = Math.max(0, ...totals);
  if (days.length === 0) return <Muted className={styles.empty}>No usage to chart in this range yet.</Muted>;
  if (max === 0) return <Muted className={styles.empty}>Nothing to draw: every token series is switched off, or there was no token usage on these days.</Muted>;
  const ticks = new Set(axisTicks(days.length, days.length > 60 ? 14 : 7));

  return (
    <div className={styles.wrap}>
      <div className={styles.legend}>
        {SERIES.filter((s) => !hidden.has(s.key)).map((s) => (
          <span key={s.key} className={styles.legendItem}>
            <span className={styles.swatch} style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
        <span className={styles.max}>busiest day: {NF.format(max)} tokens</span>
      </div>
      <div className={styles.plot} role="img" aria-label={`Tokens per day over ${days.length} days, busiest day ${NF.format(max)}`}>
        {days.map((d, i) => {
          const parts = SERIES.filter((s) => !hidden.has(s.key)).map((s) => ({ ...s, value: d.totals[s.key] }));
          return (
            <div
              key={d.date}
              className={styles.col}
              onMouseEnter={(e) => setTip({ x: e.clientX, y: e.clientY, day: dayLabel(d.date), lines: [...parts.map((p) => `${p.label} ${NF.format(p.value)}`), `${NF.format(d.totals.requests)} requests`] })}
              onMouseMove={(e) => setTip((t) => (t ? { ...t, x: e.clientX, y: e.clientY } : t))}
              onMouseLeave={() => setTip(null)}
            >
              <div className={styles.stack} style={{ height: `${(totals[i]! / max) * 100}%` }}>
                {parts.map((p) => (
                  <div key={p.key} style={{ flexGrow: p.value, background: p.color, minHeight: p.value > 0 ? 1 : 0 }} />
                ))}
              </div>
              <span className={styles.tick}>{ticks.has(i) ? dayLabel(d.date) : ''}</span>
            </div>
          );
        })}
      </div>
      {tip && (
        <div className={styles.tip} style={{ left: tip.x + 12, top: tip.y + 12 }}>
          <strong>{tip.day}</strong>
          {tip.lines.map((l) => (
            <div key={l}>{l}</div>
          ))}
        </div>
      )}
    </div>
  );
}
