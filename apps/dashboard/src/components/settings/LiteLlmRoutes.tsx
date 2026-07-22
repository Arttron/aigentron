import { useEffect, useState } from 'react';
import { api, type LitellmRoute } from '@/lib/api';
import { Card, SectionTitle, Badge, Muted, ErrorText } from '@/components/ui';
import styles from './LiteLlmRoutes.module.css';

/**
 * Read-only view of what the LiteLLM proxy serves. `managed` routes are
 * registered automatically by the orchestrator from OpenAI-native providers;
 * the others come from infra/litellm-config.yaml (e.g. Ollama). Upstream keys
 * are never exposed here — LiteLLM stores them encrypted.
 */
export function LiteLlmRoutes() {
  const [routes, setRoutes] = useState<LitellmRoute[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listLitellmRoutes()
      .then(setRoutes)
      .catch((e) => setError((e as Error).message));
  }, []);

  return (
    <Card>
      <SectionTitle>LiteLLM proxy routes</SectionTitle>
      <Muted className={styles.intro}>
        What the local LiteLLM proxy can serve. <strong>Managed</strong> routes are created
        automatically from OpenAI-native providers (so agents, which speak only the Anthropic
        protocol, can use them) — you don&apos;t configure these by hand. Upstream keys live in the
        provider record and LiteLLM; they never appear here.
      </Muted>

      {error && <ErrorText>{error}</ErrorText>}
      {routes && routes.length === 0 && <Muted>No routes configured.</Muted>}

      {routes?.map((r) => (
        <div key={r.modelName} className={styles.row}>
          <code className={styles.name}>{r.modelName}</code>
          <span className={styles.arrow}>→</span>
          <code className={styles.backend}>{r.backend ?? '—'}</code>
          {r.managed ? <Badge tone="running">managed</Badge> : <Badge tone="neutral">static</Badge>}
        </div>
      ))}
    </Card>
  );
}
