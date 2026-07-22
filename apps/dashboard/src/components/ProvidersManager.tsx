'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, type ProviderInfo, type ProviderTestResult } from '@/lib/api';
import { cn } from '@/lib/cn';
import { Card, SectionTitle, Field, Row, Button, Modal, Badge, Muted, ErrorText } from '@/components/ui';
import { ProviderForm, type ProviderFormValues } from './ProviderForm';
import styles from './ProvidersManager.module.css';

type ModalState = { mode: 'add' } | { mode: 'edit'; provider: ProviderInfo } | null;

export function ProvidersManager() {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [defaultProvider, setDefaultProvider] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<ModalState>(null);
  const [testing, setTesting] = useState<Record<string, boolean>>({});
  const [results, setResults] = useState<Record<string, ProviderTestResult>>({});

  const refresh = useCallback(async () => {
    try {
      const [list, settings] = await Promise.all([api.listProviders(), api.getSettings()]);
      setProviders(list);
      setDefaultProvider(settings.defaultProvider ?? '');
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const submitForm = async (values: ProviderFormValues) => {
    // Rate caps: a number sets the cap, 0 clears it (blank input → 0).
    const rpm = values.rpm.trim() === '' ? 0 : Number(values.rpm);
    const tpm = values.tpm.trim() === '' ? 0 : Number(values.tpm);
    if (modal?.mode === 'edit') {
      await api.updateProvider(modal.provider.name, {
        kind: values.kind,
        baseUrl: values.baseUrl,
        model: values.model,
        authMode: values.authMode,
        rpm,
        tpm,
        ...(values.secret.trim() ? { secret: values.secret.trim() } : {}),
      });
    } else {
      await api.createProvider({
        name: values.name.trim(),
        kind: values.kind,
        baseUrl: values.baseUrl.trim() || undefined,
        model: values.model.trim(),
        authMode: values.authMode,
        ...(rpm ? { rpm } : {}),
        ...(tpm ? { tpm } : {}),
        secret: values.secret.trim() || undefined,
      });
    }
    setModal(null);
    await refresh();
  };

  const remove = async (name: string) => {
    if (!window.confirm(`Delete provider "${name}"?`)) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteProvider(name);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const test = async (name: string) => {
    setTesting((t) => ({ ...t, [name]: true }));
    setResults((r) => ({ ...r, [name]: undefined as never }));
    try {
      const result = await api.testProvider(name);
      setResults((r) => ({ ...r, [name]: result }));
    } catch (e) {
      setResults((r) => ({ ...r, [name]: { ok: false, error: (e as Error).message } }));
    } finally {
      setTesting((t) => ({ ...t, [name]: false }));
    }
  };

  const pickDefault = async (name: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.updateSettings({ defaultProvider: name });
      setDefaultProvider(name);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <Row spaceBetween>
        <SectionTitle className={styles.flush}>Providers (model endpoints)</SectionTitle>
        <Button variant="primary" onClick={() => setModal({ mode: 'add' })}>
          + Add provider
        </Button>
      </Row>

      <Field label="Default provider — used by tasks that don't pick an agent">
        <select
          className={styles.defaultSelect}
          value={defaultProvider}
          onChange={(e) => pickDefault(e.target.value)}
          disabled={busy}
        >
          {providers.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
            </option>
          ))}
        </select>
      </Field>

      {providers.map((p) => {
        const r = results[p.name];
        return (
          <div key={p.name} className={styles.entry}>
            <Row spaceBetween className={styles.head}>
              <div className={styles.ident}>
                <strong>{p.name}</strong>
                {defaultProvider === p.name && <Badge tone="running">default</Badge>}
              </div>
              <Row>
                <Button size="sm" disabled={testing[p.name]} onClick={() => test(p.name)}>
                  {testing[p.name] ? 'Testing…' : 'Test'}
                </Button>
                <Button size="sm" onClick={() => setModal({ mode: 'edit', provider: p })}>
                  Edit
                </Button>
                <Button variant="red" size="sm" disabled={busy} onClick={() => remove(p.name)}>
                  Delete
                </Button>
              </Row>
            </Row>
            <Muted className={styles.meta}>
              {p.kind} · {p.model || 'no default model'} · {p.baseUrl || 'native'} · {p.authMode}
              {p.secretSet ? ` · secret ${p.secretHint}` : ' · no secret'}
            </Muted>
            {r &&
              (p.authMode === 'oauth-token' && !r.ok ? (
                <Muted className={styles.result}>ⓘ {r.error}</Muted>
              ) : (
                <div className={cn(styles.result, r.ok ? styles.ok : styles.fail)}>
                  {r.ok ? (
                    <>
                      ✓ responded as <strong>{r.model}</strong>
                      {typeof r.latencyMs === 'number' ? ` · ${r.latencyMs}ms` : ''}
                      {r.toolUse === true
                        ? ' · tools ✓'
                        : r.toolUse === false
                          ? ' · tools ✗ (unusable for agents)'
                          : r.toolUseNote
                            ? ` · tools ? (${r.toolUseNote})`
                            : ''}
                      {r.reply ? ` · “${r.reply}”` : ''}
                    </>
                  ) : (
                    <>✗ {r.error}{r.status ? ` (HTTP ${r.status})` : ''}</>
                  )}
                </div>
              ))}
          </div>
        );
      })}

      {error && <ErrorText className={styles.error}>{error}</ErrorText>}

      {modal && (
        <Modal
          title={modal.mode === 'edit' ? `Edit provider: ${modal.provider.name}` : 'Add provider'}
          onClose={() => setModal(null)}
        >
          <ProviderForm
            initial={modal.mode === 'edit' ? modal.provider : undefined}
            onSubmit={submitForm}
            onCancel={() => setModal(null)}
          />
        </Modal>
      )}
    </Card>
  );
}
