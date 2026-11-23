import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Badge, Button, ErrorText, Muted, Row } from '@/components/ui';
import styles from './LocalAgentPanels.module.css';

type Info = Awaited<ReturnType<typeof api.localAgentLlm>>;

/** Models that run on the people's own computers (Ollama, LM Studio, llama-server), shared with the server through the local agent. */
export function LocalAgentLlm() {
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const load = useCallback(() => void api.localAgentLlm().then((i) => (setInfo(i), setBaseUrl((b) => b || i.baseUrl))).catch((e: Error) => setError(e.message)), []);
  useEffect(load, [load]);

  const use = (model: string) =>
    void api
      .localAgentLlmProvider({ model, baseUrl })
      .then((r) => (setDone(`Provider "${r.name}" now points at ${r.model}. Choose it for an agent in Agents → provider.`), setError(null), load()))
      .catch((e: Error) => setError(e.message));

  return (
    <div className={styles.section}>
      <strong className={styles.title}>Models on your computers</strong>
      <Muted className={styles.note}>
        A model running on a connected computer (Ollama, LM Studio, llama.cpp&apos;s <code>llama-server</code>) can serve the agents of this server: the request goes over the line the local agent already holds open, no port is opened. You choose what is shared, <em>on that computer</em>:
        <br />
        <code>aigentron llm add ollama http://localhost:11434</code> (LM Studio: <code>http://localhost:1234</code>), then <code>aigentron llm allow &apos;qwen3-coder*&apos;</code>. Nothing is shared by default, and the server cannot widen the list.
      </Muted>
      {error && <ErrorText>{error}</ErrorText>}
      {done && <Muted className={styles.note}>{done}</Muted>}
      {info && info.models.length === 0 && <Muted className={styles.note}>No shared model right now (the computer must be online and have allowed at least one model).</Muted>}
      {info && info.models.length > 0 && (
        <>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Computer</th>
                  <th>Backend</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {info.models.map((m) => (
                  <tr key={`${m.deviceId}:${m.id}`}>
                    <td>
                      <code className={styles.path}>{m.id}</code>
                    </td>
                    <td>{m.deviceLabel}</td>
                    <td>{m.backend}</td>
                    <td>
                      <Button size="sm" onClick={() => use(m.id)}>
                        Use as provider
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Row wrap>
            <label>
              Address of this server as <em>LiteLLM</em> sees it:{' '}
              <input style={{ width: 340 }} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
            </label>
            {info.provider && <Badge tone="done">provider {info.provider.name}: {info.provider.model}</Badge>}
          </Row>
          <Muted>Change the address if LiteLLM cannot reach the default one (for example <code>http://host.docker.internal:3001/api/local-llm/v1</code>). When the computer is offline or stops answering, the run moves to the agent's next provider — set <code>fallbackProviders</code> on the agent (local first, cloud as the fallback, or the other way round); a down computer is skipped for a minute and then tried again.</Muted>
        </>
      )}
    </div>
  );
}
