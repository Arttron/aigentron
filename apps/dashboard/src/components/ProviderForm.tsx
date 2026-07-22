'use client';

import { useState } from 'react';
import { api, type ProviderInfo, type ProviderKind, type ProviderAuthMode } from '@/lib/api';
import { Field, Row, Button, Muted, ErrorText } from '@/components/ui';
import styles from './ProviderForm.module.css';

export interface ProviderFormValues {
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  authMode: ProviderAuthMode;
  secret: string;
  /** Rate caps as strings for the inputs; empty = no cap. */
  rpm: string;
  tpm: string;
}

const KINDS: ProviderKind[] = ['anthropic', 'openai', 'deepseek', 'ollama'];

/** Best-effort default kind from a base URL (mirrors the server). */
function defaultKind(url: string): ProviderKind {
  const u = url.toLowerCase();
  if (!u || u.includes('api.anthropic.com') || u.includes('api.z.ai')) return 'anthropic';
  if (u.includes('api.deepseek.com')) return 'deepseek';
  if (u.includes('api.openai.com')) return 'openai';
  if (u.includes('11434') || u.includes('ollama')) return 'ollama';
  return 'openai';
}

/** Add/edit form for a provider; reused inside the Providers modal. */
export function ProviderForm({
  initial,
  onSubmit,
  onCancel,
}: {
  initial?: ProviderInfo;
  onSubmit: (values: ProviderFormValues) => Promise<void>;
  onCancel: () => void;
}) {
  const isNew = !initial;
  const [values, setValues] = useState<ProviderFormValues>({
    name: initial?.name ?? '',
    kind: initial?.kind ?? defaultKind(initial?.baseUrl ?? ''),
    baseUrl: initial?.baseUrl ?? '',
    model: initial?.model ?? '',
    authMode: initial?.authMode ?? 'auth-token',
    secret: '',
    rpm: initial?.rpm != null ? String(initial.rpm) : '',
    tpm: initial?.tpm != null ? String(initial.tpm) : '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);

  const set = <K extends keyof ProviderFormValues>(k: K, v: ProviderFormValues[K]) =>
    setValues((s) => ({ ...s, [k]: v }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!values.name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(values);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /** Fetch the endpoint's model list to pick a default from. */
  const loadModels = async () => {
    setLoadingModels(true);
    setModelsError(null);
    try {
      // On edit with an untouched secret, query the saved provider (its real
      // secret); otherwise preview from the params being entered.
      const r =
        initial && !values.secret.trim()
          ? await api.listProviderModels(initial.name)
          : await api.previewProviderModels({
              kind: values.kind,
              baseUrl: values.baseUrl,
              authMode: values.authMode,
              secret: values.secret,
            });
      setModels(r.models);
      if (!r.ok) setModelsError(r.error ?? 'failed to load models');
      else if (r.models.length === 0) setModelsError('endpoint returned no models');
    } catch (e) {
      setModelsError((e as Error).message);
    } finally {
      setLoadingModels(false);
    }
  };

  return (
    <form onSubmit={submit}>
      {isNew && (
        <Field label="Name">
          <input value={values.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. deepseek" />
        </Field>
      )}
      <Field label="Kind (upstream family — sets the LiteLLM backend)">
        <select value={values.kind} onChange={(e) => set('kind', e.target.value as ProviderKind)}>
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Base URL (blank = the family's native default)">
        <input
          value={values.baseUrl}
          onChange={(e) => {
            const v = e.target.value;
            // Keep kind in step with the URL until the user overrides it.
            setValues((s) => ({ ...s, baseUrl: v, kind: defaultKind(v) }));
          }}
          placeholder="https://api.openai.com/v1"
        />
        {values.kind !== 'anthropic' && (
          <Muted className={styles.note}>
            Non-Anthropic — auto-proxied through LiteLLM so agents (Anthropic-only) can use it.
          </Muted>
        )}
      </Field>
      <Field label="Auth mode">
        <select value={values.authMode} onChange={(e) => set('authMode', e.target.value as ProviderFormValues['authMode'])}>
          <option value="auth-token">auth-token</option>
          <option value="api-key">api-key</option>
          <option value="oauth-token">oauth-token (Claude subscription)</option>
        </select>
        {values.authMode === 'oauth-token' && (
          <Muted className={styles.note}>
            Run <code>claude setup-token</code> locally (or <code>scripts/cli-auth.sh &lt;name&gt;</code>) and
            paste the printed token below. Bypasses LiteLLM — talks to Anthropic directly, so Base URL is
            ignored; this provider also can’t be delegated to as a subagent. Expires after 1 year (no
            auto-refresh) — rotate by repeating this with the same provider name.
          </Muted>
        )}
      </Field>
      <Field
        label={
          initial?.secretSet
            ? `Secret — set (${initial.secretHint}); leave blank to keep`
            : values.authMode === 'oauth-token'
              ? 'Secret (OAuth token from `claude setup-token`)'
              : 'Secret (API key / auth token)'
        }
      >
        <input
          type="password"
          value={values.secret}
          onChange={(e) => set('secret', e.target.value)}
          placeholder={initial?.secretSet ? 'leave blank to keep' : 'secret'}
        />
      </Field>
      <Field label="Default model (optional — agents can pick their own)">
        <Row>
          <input
            className={styles.grow}
            value={values.model}
            onChange={(e) => set('model', e.target.value)}
            placeholder="e.g. claude-sonnet-4-6"
          />
          <Button onClick={loadModels} disabled={loadingModels}>
            {loadingModels ? 'Loading…' : 'Load models'}
          </Button>
        </Row>
        {modelsError && <Muted className={styles.note}>could not load models: {modelsError}</Muted>}
        {models.length > 0 &&
          (() => {
            // Local = an Ollama tag running on your hardware. Cloud = a remote
            // upstream (anthropic/openai/deepseek), or an Ollama `:cloud` tag
            // (e.g. glm-5:cloud) that the local daemon proxies to Ollama cloud.
            const isLocal = (m: string) => values.kind === 'ollama' && !/:cloud$/i.test(m);
            const local = models.filter(isLocal);
            const cloud = models.filter((m) => !isLocal(m));
            return (
              <select
                className={styles.picker}
                value=""
                onChange={(e) => e.target.value && set('model', e.target.value)}
              >
                <option value="">— pick from {models.length} models —</option>
                {local.length > 0 && (
                  <optgroup label="Local (on your hardware)">
                    {local.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </optgroup>
                )}
                {cloud.length > 0 && (
                  <optgroup label="Cloud">
                    {cloud.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            );
          })()}
      </Field>
      <Field label="Rate limits (optional — LiteLLM caps + retries; blank = none)">
        <Row>
          <input
            type="number"
            min={0}
            className={styles.grow}
            value={values.rpm}
            onChange={(e) => set('rpm', e.target.value)}
            placeholder="requests / min"
          />
          <input
            type="number"
            min={0}
            className={styles.grow}
            value={values.tpm}
            onChange={(e) => set('tpm', e.target.value)}
            placeholder="tokens / min"
          />
        </Row>
        <Muted className={styles.note}>
          Set for rate-limited upstreams (e.g. GPT). LiteLLM paces requests and retries 429s.
        </Muted>
      </Field>
      <Row>
        <Button variant="primary" type="submit" disabled={busy || !values.name.trim()}>
          {busy ? 'Saving…' : isNew ? 'Add provider' : 'Save changes'}
        </Button>
        <Button onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        {error && <ErrorText>{error}</ErrorText>}
      </Row>
    </form>
  );
}
