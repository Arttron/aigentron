import { useEffect, useState } from 'react';
import { formatEscalationStep, parseEscalationStep, type ModelInfo } from '@lds/shared';
import { api } from '@/lib/api';
import { Button, Muted } from '@/components/ui';

const TIER_LABEL = { cheap: 'cheap', mid: 'mid', top: 'top' } as const;

/** "cheap · $0.15 / $0.6 per M" — what is known about a model's cost, and where it comes from. */
export function modelCostLabel(m: ModelInfo | undefined): string {
  if (!m) return '';
  const price = m.source === 'local' ? 'local, free' : m.inputPerM !== undefined ? `$${m.inputPerM} / $${m.outputPerM ?? '?'} per M` : 'by name';
  return `${TIER_LABEL[m.tier]} · ${price}`;
}

/** One step: a provider and a model of it (its models are listed cheapest first, with their cost). */
/** One provider + model pair (written `provider/model`); `onRemove` adds a Remove button. */
export function ModelStep({ value, providers, onChange, onRemove }: { value: string; providers: string[]; onChange: (v: string) => void; onRemove?: () => void }) {
  const parsed = parseEscalationStep(value) ?? { provider: providers[0] ?? '', model: '' };
  const [info, setInfo] = useState<ModelInfo[]>([]);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setInfo([]);
    setErr(null);
    if (!parsed.provider) return;
    void api
      .listProviderModels(parsed.provider)
      .then((r) => {
        if (!live) return;
        setInfo(r.info ?? r.models.map((id) => ({ id, tier: 'mid' as const, source: 'name' as const })));
        if (!r.ok) setErr(r.error ?? 'could not list models');
      })
      .catch((e) => live && setErr((e as Error).message));
    return () => {
      live = false;
    };
  }, [parsed.provider]);
  const byId = new Map(info.map((m) => [m.id, m]));
  const options = parsed.model && !byId.has(parsed.model) ? [{ id: parsed.model, tier: 'mid' as const, source: 'name' as const }, ...info] : info;
  const missingProvider = Boolean(parsed.provider) && !providers.includes(parsed.provider);
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
      <select value={parsed.provider} onChange={(e) => onChange(formatEscalationStep(e.target.value, ''))} style={{ maxWidth: 180 }} aria-label="Provider of this step">
        {missingProvider && <option value={parsed.provider}>{parsed.provider} (no longer exists)</option>}
        {providers.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>
      <select
        value={parsed.model}
        onChange={(e) => onChange(formatEscalationStep(parsed.provider, e.target.value))}
        style={{ minWidth: 260, maxWidth: 420 }}
        aria-label="Model of this step"
      >
        <option value="">— choose a model —</option>
        {options.map((m) => (
          <option key={m.id} value={m.id}>
            {m.id} — {modelCostLabel(m)}
          </option>
        ))}
      </select>
      {onRemove && (
        <Button size="sm" onClick={onRemove}>
          Remove
        </Button>
      )}
      {err && <Muted>{err}</Muted>}
    </div>
  );
}

/**
 * The escalation ladder of an agent: steps from cheaper to stronger. A run starts on the agent's own model; when it could not finish the work
 * (reported failure, out of time or steps) the task continues on the next step. Fallback providers are only tried when no step is available.
 */
export function EscalationEditor({ steps, providers, onChange }: { steps: string[]; providers: string[]; onChange: (v: string[]) => void }) {
  return (
    <div>
      {steps.map((s, i) => (
        <ModelStep key={i} value={s} providers={providers} onChange={(v) => onChange(steps.map((x, j) => (j === i ? v : x)))} onRemove={() => onChange(steps.filter((_, j) => j !== i))} />
      ))}
      <Button size="sm" disabled={!providers.length} onClick={() => onChange([...steps, formatEscalationStep(providers[0] ?? '', '')])}>
        + Add a stronger step
      </Button>
      <Muted>
        Order the steps from cheaper to stronger. The run starts on the agent&apos;s own model; if it reports it could not finish, or runs out of time or steps, the task goes on in a fresh session on the next step with a note of what
        was done. A step that is unavailable (quota, error) is skipped; the fallback providers below are used only when no step is available — so with a ladder, an error on the agent's own model moves straight to the first step. The same ladder fixes a red verification gate: the first auto-fix stays on the agent's own model, the next ones go up the steps (set the number of attempts under Settings → Work → Verify). Not used for ordinary follow-up messages (the conversation stays with its model).
      </Muted>
    </div>
  );
}
