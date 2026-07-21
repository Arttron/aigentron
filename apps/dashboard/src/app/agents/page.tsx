'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, type AgentInfo, type McpServerInfo, type ProviderInfo } from '@/lib/api';
import {
  AppHeader,
  BackLink,
  Card,
  SectionTitle,
  Row,
  Button,
  Field,
  Badge,
  CheckboxGroup,
  Muted,
  ErrorText,
} from '@/components/ui';
import styles from './page.module.css';

type Form = {
  name: string;
  description: string;
  provider: string;
  fallbackProviders: string[];
  model: string;
  skills: string[];
  allowedTools: string;
  disallowedTools: string;
  mcp: string[];
  instructions: string;
};

const emptyForm: Form = {
  name: '',
  description: '',
  provider: '',
  fallbackProviders: [],
  model: '',
  skills: [],
  allowedTools: '',
  disallowedTools: '',
  mcp: [],
  instructions: '',
};

export default function AgentsPage() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [skillOptions, setSkillOptions] = useState<string[]>([]);
  const [mcpOptions, setMcpOptions] = useState<McpServerInfo[]>([]);
  const [form, setForm] = useState<Form | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Models advertised by the currently-selected provider (for the model picker).
  const [models, setModels] = useState<string[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [a, p, sk, mcp] = await Promise.all([
        api.listAgents(),
        api.listProviders(),
        api.listSkills(),
        api.listMcp(),
      ]);
      setAgents(a);
      setProviders(p);
      setSkillOptions(sk);
      setMcpOptions(mcp);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Reload the model list whenever the form's provider changes.
  const selectedProvider = form?.provider ?? '';
  useEffect(() => {
    if (!selectedProvider) {
      setModels([]);
      setModelsError(null);
      return;
    }
    let active = true;
    setModelsLoading(true);
    setModelsError(null);
    api
      .listProviderModels(selectedProvider)
      .then((r) => {
        if (!active) return;
        setModels(r.models);
        if (!r.ok) setModelsError(r.error ?? 'failed to load models');
      })
      .catch((e) => active && setModelsError((e as Error).message))
      .finally(() => active && setModelsLoading(false));
    return () => {
      active = false;
    };
  }, [selectedProvider]);

  const edit = async (name: string) => {
    setError(null);
    try {
      const a = await api.getAgent(name);
      setIsNew(false);
      setForm({
        name: a.name,
        description: a.description ?? '',
        provider: a.provider ?? '',
        fallbackProviders: a.fallbackProviders ?? [],
        model: a.model ?? '',
        skills: a.skills ?? [],
        allowedTools: (a.allowedTools ?? []).join(', '),
        disallowedTools: (a.disallowedTools ?? []).join(', '),
        mcp: a.mcp ?? [],
        instructions: a.instructions ?? '',
      });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const startNew = () => {
    setError(null);
    setIsNew(true);
    setForm({ ...emptyForm, provider: providers[0]?.name ?? '' });
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form) return;
    setBusy(true);
    setError(null);
    try {
      const body = {
        description: form.description,
        provider: form.provider || undefined,
        fallbackProviders: form.fallbackProviders.join(', '),
        model: form.model || undefined,
        skills: form.skills.join(', '),
        allowedTools: form.allowedTools,
        disallowedTools: form.disallowedTools,
        mcp: form.mcp.join(', '),
        instructions: form.instructions,
      };
      if (isNew) await api.createAgent({ name: form.name, ...body });
      else await api.updateAgent(form.name, body);
      await refresh();
      setForm(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (name: string) => {
    if (!window.confirm(`Delete agent "${name}"?`)) return;
    try {
      await api.deleteAgent(name);
      if (form?.name === name) setForm(null);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const upd = (k: keyof Form, v: string) => setForm((f) => (f ? { ...f, [k]: v } : f));
  const setList = (k: 'skills' | 'mcp' | 'fallbackProviders', v: string[]) =>
    setForm((f) => (f ? { ...f, [k]: v } : f));

  const selectedProviderInfo = providers.find((p) => p.name === selectedProvider);
  const providerDefaultModel = selectedProviderInfo?.model;
  // Keep the agent's saved model in the list even if the endpoint didn't report it.
  const modelOptions =
    form?.model && !models.includes(form.model) ? [form.model, ...models] : models;

  return (
    <>
      <BackLink href="/">← all tasks</BackLink>
      <AppHeader title="🧑‍💻 Agents" actions={<Link href="/settings">⚙ Settings</Link>} />

      {error && (
        <Card>
          <ErrorText>{error}</ErrorText>
        </Card>
      )}

      <Card>
        <Row spaceBetween>
          <SectionTitle className={styles.flush}>Agents ({agents.length})</SectionTitle>
          <Button variant="primary" onClick={startNew}>
            + New agent
          </Button>
        </Row>
        <ul className={styles.list}>
          {agents.map((a) => (
            <li key={a.name} className={styles.item}>
              <strong className={styles.name}>{a.name}</strong>
              <Muted className={styles.desc}>{a.description}</Muted>
              {a.provider && <Badge tone="neutral">{a.provider}</Badge>}
              <Button size="sm" onClick={() => edit(a.name)}>
                Edit
              </Button>
              <Button variant="red" size="sm" onClick={() => remove(a.name)}>
                ✕
              </Button>
            </li>
          ))}
        </ul>
      </Card>

      {form && (
        <Card as="form" onSubmit={save}>
          <SectionTitle>{isNew ? 'New agent' : `Edit: ${form.name}`}</SectionTitle>
          {isNew && (
            <Field label="Name (filename)">
              <input
                value={form.name}
                onChange={(e) => upd('name', e.target.value)}
                placeholder="e.g. backend"
              />
            </Field>
          )}
          <Field label="Description">
            <input value={form.description} onChange={(e) => upd('description', e.target.value)} />
          </Field>
          <Field label="Provider (model endpoint)">
            <select
              className={styles.providerSelect}
              value={form.provider}
              onChange={(e) => upd('provider', e.target.value)}
            >
              <option value="">(default provider)</option>
              {providers.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Model (default uses the provider's default model)">
            <select
              className={styles.providerSelect}
              value={form.model}
              onChange={(e) => upd('model', e.target.value)}
              disabled={!form.provider}
            >
              <option value="">
                default ({providerDefaultModel || 'provider default'})
              </option>
              {modelOptions.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            {!form.provider ? (
              <Muted className={styles.modelHint}>pick a provider to list its models</Muted>
            ) : modelsLoading ? (
              <Muted className={styles.modelHint}>loading models…</Muted>
            ) : modelsError ? (
              <Muted className={styles.modelHint}>could not load models: {modelsError}</Muted>
            ) : null}
          </Field>
          <Field label="Fallback providers (tried in order if the primary run errors)">
            <CheckboxGroup
              options={providers.map((p) => p.name).filter((n) => n !== form.provider)}
              selected={form.fallbackProviders}
              onChange={(v) => setList('fallbackProviders', v)}
              empty="no other providers to fall back to"
            />
          </Field>
          <Field label="Skills (none selected = all skills apply)">
            <CheckboxGroup
              options={skillOptions}
              selected={form.skills}
              onChange={(v) => setList('skills', v)}
              empty="no skills found in ./agent/skills"
            />
          </Field>
          <Field label="Disallowed tools (comma-separated; e.g. read-only reviewer)">
            <input
              value={form.disallowedTools}
              onChange={(e) => upd('disallowedTools', e.target.value)}
              placeholder="Write, Edit, NotebookEdit"
            />
          </Field>
          <Field label="Allowed tools (comma-separated; blank = all available)">
            <input
              value={form.allowedTools}
              onChange={(e) => upd('allowedTools', e.target.value)}
              placeholder="leave blank unless restricting to a whitelist"
            />
          </Field>
          <Field label="MCP servers (tool servers this agent may connect to)">
            <CheckboxGroup
              options={mcpOptions.map((m) => m.name)}
              selected={form.mcp}
              onChange={(v) => setList('mcp', v)}
              empty="no MCP servers — add them under Settings → MCP servers"
            />
          </Field>
          <Field label="Instructions (system prompt)">
            <textarea
              value={form.instructions}
              onChange={(e) => upd('instructions', e.target.value)}
              rows={8}
            />
          </Field>
          <Row>
            <Button
              variant="primary"
              type="submit"
              disabled={busy || !form.instructions.trim() || (isNew && !form.name.trim())}
            >
              {busy ? 'Saving…' : 'Save'}
            </Button>
            <Button onClick={() => setForm(null)}>Cancel</Button>
          </Row>
        </Card>
      )}
    </>
  );
}
