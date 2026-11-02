import type { UsageReport } from '@lds/shared';
import { Muted, SectionTitle } from '@/components/ui';

const NF = new Intl.NumberFormat();

/** Stats → how often work had to go to a stronger model (and why), and what the light question mode handled. */
export function EscalationStats({ report }: { report: UsageReport }) {
  const e = report.escalation;
  const a = report.ask;
  const reasons = Object.entries(e?.byReason ?? {}).sort((x, y) => y[1] - x[1]);
  const maxReason = Math.max(1, ...reasons.map(([, n]) => n));
  return (
    <div>
      {e && e.runs > 0 && (
        <>
          <SectionTitle>Escalations</SectionTitle>
          <Muted>
            {NF.format(e.runs)} run{e.runs === 1 ? '' : 's'} on a stronger model, {NF.format(e.tasks)} task{e.tasks === 1 ? '' : 's'}: the cheaper model reported it could not finish, ran out of time or steps, or its work did not pass the checks.
            Many escalations mean the first model is too weak for this work (or the ladder starts too low); none mean the cheap model is enough.
          </Muted>
          <div style={{ display: 'grid', gap: 6, margin: '8px 0' }}>
            {reasons.map(([reason, n]) => (
              <div key={reason} style={{ display: 'grid', gridTemplateColumns: 'minmax(160px, 260px) 1fr auto', gap: 10, alignItems: 'center', fontSize: 13 }}>
                <span>{reason}</span>
                <span style={{ background: 'var(--surface-2, rgba(128,128,128,.15))', borderRadius: 4, height: 12, overflow: 'hidden' }}>
                  <span style={{ display: 'block', height: '100%', width: `${Math.max(3, (n / maxReason) * 100)}%`, background: 'var(--viz-output, #d9822b)', borderRadius: 4 }} />
                </span>
                <span style={{ fontVariantNumeric: 'tabular-nums' }}>{NF.format(n)}</span>
              </div>
            ))}
          </div>
          {e.paths.length > 0 && (
            <ul style={{ margin: '4px 0 14px', paddingLeft: 18, fontSize: 13 }}>
              {e.paths.slice(0, 8).map((p) => (
                <li key={`${p.from}→${p.to}`}>
                  <code>{p.from}</code> → <code>{p.to}</code> · {NF.format(p.count)}×
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {a && a.sessions > 0 && (
        <>
          <SectionTitle>Questions</SectionTitle>
          <Muted>
            {NF.format(a.tasks)} question{a.tasks === 1 ? '' : 's'} answered by the light mode ({NF.format(a.sessions)} run{a.sessions === 1 ? '' : 's'}): {NF.format(a.inputTokens)} input and {NF.format(a.outputTokens)} output tokens
            {a.estCostUsd > 0 ? `, ≈ $${a.estCostUsd < 0.01 ? a.estCostUsd.toFixed(4) : a.estCostUsd.toFixed(2)}` : ''}. Choose their model in Settings → Work → Questions.
          </Muted>
        </>
      )}
    </div>
  );
}
