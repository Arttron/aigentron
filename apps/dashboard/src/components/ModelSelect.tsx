import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

const OTHER = '__other__';

/** A drop-down of known values with an "Other…" entry that reveals a text box — for values a list may not contain (models, voices). */
export function SelectWithOther({
  value,
  options,
  onChange,
  placeholder,
  groups,
}: {
  value: string;
  options: string[];
  onChange: (v: string) => void;
  placeholder?: string;
  /** Extra labelled groups shown after the main options (e.g. "From the provider"). */
  groups?: { label: string; options: string[] }[];
}) {
  const known = new Set([...options, ...(groups ?? []).flatMap((g) => g.options)]);
  const [custom, setCustom] = useState(false);
  const typed = custom || (value !== '' && !known.has(value));
  return (
    <>
      <select
        value={typed ? OTHER : value}
        onChange={(e) => {
          if (e.target.value === OTHER) {
            setCustom(true);
            return;
          }
          setCustom(false);
          onChange(e.target.value);
        }}
      >
        {value === '' && <option value="">{placeholder ?? '— choose —'}</option>}
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
        {(groups ?? []).map(
          (g) =>
            g.options.length > 0 && (
              <optgroup key={g.label} label={g.label}>
                {g.options.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </optgroup>
            ),
        )}
        <option value={OTHER}>Other…</option>
      </select>
      {typed && <input style={{ marginTop: 6 }} value={value} onChange={(e) => onChange(e.target.value)} placeholder="type the exact name" autoFocus={custom} />}
    </>
  );
}

/** Model picker: a few suggestions, the models the chosen provider reports (optionally filtered), and "Other…". */
export function ModelSelect({
  provider,
  value,
  onChange,
  suggestions = [],
  match,
  placeholder,
}: {
  provider: string;
  value: string;
  onChange: (v: string) => void;
  suggestions?: string[];
  /** Show only provider models whose name matches (e.g. speech models). */
  match?: RegExp;
  placeholder?: string;
}) {
  const [models, setModels] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    setModels([]);
    if (provider)
      api
        .listProviderModels(provider)
        .then((r) => live && setModels(r.models ?? []))
        .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [provider]);
  const fromProvider = (match ? models.filter((m) => match.test(m)) : models).filter((m) => !suggestions.includes(m));
  return (
    <SelectWithOther
      value={value}
      options={suggestions}
      groups={[{ label: provider ? `Reported by ${provider}` : 'Reported by the provider', options: fromProvider }]}
      onChange={onChange}
      placeholder={placeholder}
    />
  );
}
