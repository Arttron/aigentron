'use client';

import { useState } from 'react';
import type { ProviderUsage } from '@lds/shared';
import { Muted } from '@/components/ui';
import styles from './UsageChart.module.css';

const NF = new Intl.NumberFormat();

/** The three token series, in fixed slot order (color follows the type, not rank). */
const SERIES = [
  { key: 'inputTokens', label: 'Input', color: 'var(--viz-input)' },
  { key: 'outputTokens', label: 'Output', color: 'var(--viz-output)' },
  { key: 'cacheTokens', label: 'Cache', color: 'var(--viz-cache)' },
] as const;

type Tip = { x: number; y: number; provider: string; series: string; value: number; pct: number };

/**
 * Horizontal stacked bars: total tokens per provider, split Input / Output /
 * Cache. Bar length is scaled to the busiest provider so rows compare directly;
 * the table below is the full, accessible data view. Per-segment values live in
 * the hover tooltip (segments are never individually labeled).
 */
export function UsageChart({ providers }: { providers: ProviderUsage[] }) {
  const [tip, setTip] = useState<Tip | null>(null);

  const rows = providers
    .map((p) => ({
      provider: p.provider,
      input: p.inputTokens,
      output: p.outputTokens,
      cache: p.cacheTokens,
      total: p.inputTokens + p.outputTokens + p.cacheTokens,
    }))
    .filter((r) => r.total > 0)
    .sort((a, b) => b.total - a.total);

  if (rows.length === 0) {
    return (
      <Muted className={styles.empty}>
        No token usage to chart yet for this range — bars will appear here as new runs complete.
      </Muted>
    );
  }

  const maxTotal = Math.max(...rows.map((r) => r.total));

  return (
    <div className={styles.wrap}>
      <div className={styles.legend}>
        {SERIES.map((s) => (
          <span key={s.key} className={styles.legendItem}>
            <span className={styles.swatch} style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>

      <div className={styles.rows}>
        {rows.map((r) => {
          const parts = SERIES.map((s) => ({
            label: s.label,
            color: s.color,
            value: r[s.key === 'inputTokens' ? 'input' : s.key === 'outputTokens' ? 'output' : 'cache'],
          })).filter((p) => p.value > 0);

          return (
            <div key={r.provider} className={styles.row}>
              <span className={styles.name} title={r.provider}>
                {r.provider}
              </span>
              <div className={styles.track}>
                <div
                  className={styles.bar}
                  style={{ width: `${(r.total / maxTotal) * 100}%` }}
                  role="img"
                  aria-label={`${r.provider}: ${NF.format(r.total)} tokens (${parts
                    .map((p) => `${p.label} ${NF.format(p.value)}`)
                    .join(', ')})`}
                >
                  {parts.map((p, i) => {
                    const left = i === 0 ? '4px' : '0';
                    const right = i === parts.length - 1 ? '4px' : '0';
                    return (
                      <div
                        key={p.label}
                        className={styles.seg}
                        style={{
                          flexGrow: p.value,
                          background: p.color,
                          borderRadius: `${left} ${right} ${right} ${left}`,
                        }}
                        onMouseEnter={(e) =>
                          setTip({
                            x: e.clientX,
                            y: e.clientY,
                            provider: r.provider,
                            series: p.label,
                            value: p.value,
                            pct: p.value / r.total,
                          })
                        }
                        onMouseMove={(e) =>
                          setTip((t) => (t ? { ...t, x: e.clientX, y: e.clientY } : t))
                        }
                        onMouseLeave={() => setTip(null)}
                      />
                    );
                  })}
                </div>
              </div>
              <span className={styles.total}>{NF.format(r.total)}</span>
            </div>
          );
        })}
      </div>

      {tip && (
        <div className={styles.tip} style={{ left: tip.x + 12, top: tip.y + 12 }}>
          <span className={styles.tipName}>{tip.provider} · </span>
          {tip.series} <span className={styles.tipVal}>{NF.format(tip.value)}</span>{' '}
          <span className={styles.tipName}>({Math.round(tip.pct * 100)}%)</span>
        </div>
      )}
    </div>
  );
}
