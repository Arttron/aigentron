import type { UsageReport } from '@lds/shared';
import { COMPRESSION_RULE_LABELS } from '@lds/shared';
import { Muted, SectionTitle } from '@/components/ui';

const NF = new Intl.NumberFormat();
const tokens = (chars: number) => Math.round(chars / 4);

/** One horizontal bar: a label, a bar scaled to the biggest row, and the number. */
function Bars({ rows, color }: { rows: { label: string; value: number; note?: string }[]; color: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div style={{ display: 'grid', gap: 6, margin: '8px 0 14px' }}>
      {rows.map((r) => (
        <div key={r.label} style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 220px) 1fr auto', gap: 10, alignItems: 'center', fontSize: 13 }}>
          <span title={r.label} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {r.label}
          </span>
          <span style={{ background: 'var(--surface-2, rgba(128,128,128,.15))', borderRadius: 4, height: 12, overflow: 'hidden' }}>
            <span style={{ display: 'block', height: '100%', width: `${Math.max(2, (r.value / max) * 100)}%`, background: color, borderRadius: 4 }} />
          </span>
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>
            ≈ {NF.format(tokens(r.value))} tok{r.note ? <span style={{ opacity: 0.65 }}> {r.note}</span> : null}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Stats → what our own text filters saved (no model calls): the total, which filter earned it, and which project. */
export function CompressionStats({ report }: { report: UsageReport }) {
  const c = report.compression!;
  const saved = c.before - c.after;
  const byRule = Object.entries(c.byRule)
    .map(([k, v]) => ({ label: COMPRESSION_RULE_LABELS[k] ?? `Your rule: ${k.replace(/^rule:/, '')}`, value: v }))
    .sort((a, b) => b.value - a.value);
  const byProject = (report.projects ?? [])
    .filter((p) => p.compression && p.compression.runs > 0 && (!report.project || p.slug === report.project))
    .map((p) => ({ label: p.name, value: p.compression!.before - p.compression!.after, note: `−${Math.round(((p.compression!.before - p.compression!.after) / p.compression!.before) * 100)}%` }))
    .sort((a, b) => b.value - a.value);
  return (
    <div>
      <SectionTitle>Saved by our text filters</SectionTitle>
      <Muted>
        {NF.format(c.runs)} runs: {NF.format(c.before)} → {NF.format(c.after)} characters, <strong>−{Math.round((saved / c.before) * 100)}%</strong> of the filtered text, ≈ {NF.format(tokens(saved))} input tokens that were not sent
        (about 4 characters per token; the real saving is larger on every later turn of a run, because the text is sent again each turn). Set it up in Settings → Work → Compression.
      </Muted>
      {byRule.length > 0 && (
        <>
          <Muted>By filter</Muted>
          <Bars rows={byRule} color="var(--viz-cache, #4e78ff)" />
        </>
      )}
      {!report.project && byProject.length > 0 && (
        <>
          <Muted>By project</Muted>
          <Bars rows={byProject} color="var(--viz-output, #2fa36b)" />
        </>
      )}
    </div>
  );
}
