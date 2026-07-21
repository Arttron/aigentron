'use client';

import { useEffect, useMemo, useState } from 'react';
import { api, type AgentInfo, type ChannelInfo, type ChannelInput, type ChannelKindMeta } from '@/lib/api';
import { Field, Row, Button, Muted, ErrorText } from '@/components/ui';
import styles from './ChannelForm.module.css';

/**
 * Add/edit form for a channel, rendered inside a modal. The channel kind is
 * picked from the registry (only `available` kinds are selectable; planned ones
 * are shown disabled), and the config inputs are generated from that kind's
 * field schema — so new kinds need no form changes here.
 */
export function ChannelForm({
  initial,
  kinds,
  onSubmit,
  onCancel,
}: {
  initial?: ChannelInfo;
  kinds: ChannelKindMeta[];
  onSubmit: (values: ChannelInput) => Promise<void>;
  onCancel: () => void;
}) {
  const isNew = !initial;
  const firstAvailable = kinds.find((k) => k.available)?.kind ?? '';
  const [name, setName] = useState(initial?.name ?? '');
  const [kind, setKind] = useState(initial?.kind ?? firstAvailable);
  // Per-field text values (list fields held as comma-separated strings).
  const [values, setValues] = useState<Record<string, string>>(() => initialValues(initial));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentInfo[]>([]);

  const def = useMemo(() => kinds.find((k) => k.kind === kind), [kinds, kind]);
  // Load the agent list only if this kind has an agent-picker field.
  const needsAgents = def?.fields.some((f) => f.type === 'agent') ?? false;
  useEffect(() => {
    if (needsAgents) api.listAgents().then(setAgents).catch(() => undefined);
  }, [needsAgents]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !def) return;
    setBusy(true);
    setError(null);
    try {
      const config: Record<string, unknown> = {};
      for (const f of def.fields) {
        const raw = (values[f.key] ?? '').trim();
        if (f.type === 'list') config[f.key] = raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : [];
        else if (raw) config[f.key] = raw; // blank secret/text → omit (keeps stored on edit)
      }
      await onSubmit({ name: name.trim(), kind, config });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const set = (key: string, v: string) => setValues((s) => ({ ...s, [key]: v }));

  return (
    <form onSubmit={submit}>
      {isNew && (
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. telegram-main" />
        </Field>
      )}

      <Field label="Channel type">
        <select value={kind} onChange={(e) => setKind(e.target.value)} disabled={!isNew}>
          {kinds.map((k) => (
            <option key={k.kind} value={k.kind} disabled={!k.available}>
              {k.label}
              {k.available ? '' : ' — soon'}
            </option>
          ))}
        </select>
      </Field>

      {def?.hint && <Muted className={styles.hint}>{def.hint}</Muted>}

      {def?.fields.map((f) => {
        const secretState = initial?.secrets?.[f.key];
        const label =
          f.secret && secretState?.set ? `${f.label} — set (${secretState.hint}); blank keeps it` : f.label;
        return (
          <Field key={f.key} label={label}>
            {f.type === 'agent' ? (
              <select value={values[f.key] ?? ''} onChange={(e) => set(f.key, e.target.value)}>
                <option value="">(default lead)</option>
                {agents.map((a) => (
                  <option key={a.name} value={a.name}>
                    {a.name}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type={f.secret ? 'password' : 'text'}
                value={values[f.key] ?? ''}
                onChange={(e) => set(f.key, e.target.value)}
                placeholder={f.secret && secretState?.set ? 'leave blank to keep' : f.placeholder}
              />
            )}
            {f.help && <Muted className={styles.help}>{f.help}</Muted>}
          </Field>
        );
      })}

      <Row>
        <Button variant="primary" type="submit" disabled={busy || !name.trim() || !def}>
          {busy ? 'Saving…' : isNew ? 'Add channel' : 'Save changes'}
        </Button>
        <Button onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        {error && <ErrorText>{error}</ErrorText>}
      </Row>
    </form>
  );
}

/** Seed form values from an existing channel (list → comma string; secrets blank). */
function initialValues(initial?: ChannelInfo): Record<string, string> {
  const out: Record<string, string> = {};
  if (!initial) return out;
  for (const [k, v] of Object.entries(initial.config ?? {})) {
    out[k] = Array.isArray(v) ? v.join(', ') : v == null ? '' : String(v);
  }
  return out;
}
