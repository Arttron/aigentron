import type { UsageReport } from '@lds/shared';
import { Muted, SectionTitle } from '@/components/ui';

const NF = new Intl.NumberFormat();
const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : '—');

/** Stats → how runs ended on each model: where a cheap model carries the work, and where it keeps failing, stalling or being escalated. */
export function ModelOutcomeStats({ report }: { report: UsageReport }) {
  const rows = (report.models ?? []).filter((m) => m.runs > 0);
  if (!rows.length) return null;
  return (
    <div>
      <SectionTitle>How runs ended, by model</SectionTitle>
      <Muted>
        «Done / failed / blocked» is what the agent reported; «no report» is a run that ended in an error without one (out of time or steps, a crash); «answered» is a chat turn or a question (they report nothing). A high share of failed or no-report runs on a cheap model is the sign to give the job a stronger
        model, an escalation step or a script. «Escalated in» counts runs that took over from a weaker attempt.
      </Muted>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', fontSize: 13, minWidth: 560 }}>
          <thead>
            <tr style={{ textAlign: 'right', opacity: 0.7 }}>
              <th style={{ textAlign: 'left', padding: '4px 10px 4px 0' }}>Model</th>
              <th style={{ padding: '4px 10px' }}>Runs</th>
              <th style={{ padding: '4px 10px' }}>Done</th>
              <th style={{ padding: '4px 10px' }}>Failed</th>
              <th style={{ padding: '4px 10px' }}>Blocked</th>
              <th style={{ padding: '4px 10px' }}>No report</th>
              <th style={{ padding: '4px 10px' }}>Answered</th>
              <th style={{ padding: '4px 10px' }}>Escalated in</th>
              <th style={{ padding: '4px 10px' }}>Avg steps</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr key={`${m.provider}/${m.model}`} style={{ textAlign: 'right', borderTop: '1px solid rgba(128,128,128,.2)' }}>
                <td style={{ textAlign: 'left', padding: '4px 10px 4px 0' }}>
                  <code>{m.model}</code> <span style={{ opacity: 0.6 }}>{m.provider}</span>
                </td>
                <td style={{ padding: '4px 10px' }}>{NF.format(m.runs)}</td>
                <td style={{ padding: '4px 10px' }}>{pct(m.done, m.runs)}</td>
                <td style={{ padding: '4px 10px', color: m.failed ? 'var(--red, #c0392b)' : undefined }}>{pct(m.failed, m.runs)}</td>
                <td style={{ padding: '4px 10px' }}>{pct(m.blocked, m.runs)}</td>
                <td style={{ padding: '4px 10px', color: m.runs >= 3 && m.none / m.runs >= 0.3 ? 'var(--red, #c0392b)' : undefined }}>{pct(m.none, m.runs)}</td>
                <td style={{ padding: '4px 10px' }}>{m.answered ? NF.format(m.answered) : '—'}</td>
                <td style={{ padding: '4px 10px' }}>{m.escalatedTo ? NF.format(m.escalatedTo) : '—'}</td>
                <td style={{ padding: '4px 10px' }}>{m.avgTurns}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
