import { useCallback, useEffect, useState } from 'react';
import { api, type McpServerInfo } from '@/lib/api';
import { Card, SectionTitle, Row, Button, ErrorText, Muted } from '@/components/ui';
import styles from './McpManager.module.css';

const EXAMPLE = '{\n  "type": "sse",\n  "url": "http://playwright-mcp:8931/sse"\n}';

export function McpManager() {
  const [servers, setServers] = useState<McpServerInfo[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [newName, setNewName] = useState('');
  const [newConfig, setNewConfig] = useState(EXAMPLE);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const list = await api.listMcp();
      setServers(list);
      setDrafts(Object.fromEntries(list.map((s) => [s.name, JSON.stringify(s.config, null, 2)])));
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const parse = (text: string): Record<string, unknown> => {
    const obj = JSON.parse(text);
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
      throw new Error('config must be a JSON object');
    }
    return obj as Record<string, unknown>;
  };

  const save = (name: string) => run(() => api.updateMcp(name, parse(drafts[name] ?? '{}')));

  const remove = (name: string) => {
    if (!window.confirm(`Delete MCP server "${name}"?`)) return;
    void run(() => api.deleteMcp(name));
  };

  const add = () => {
    if (!newName.trim()) return;
    void run(async () => {
      await api.createMcp({ name: newName.trim(), config: parse(newConfig) });
      setNewName('');
      setNewConfig(EXAMPLE);
    });
  };

  return (
    <Card>
      <SectionTitle>MCP servers</SectionTitle>
      <Muted className={styles.intro}>
        Tool servers agents connect to (config = Claude Agent SDK MCP config). Agents reference them
        by name in their <code>mcp</code> field.
      </Muted>

      {servers.map((s) => (
        <div key={s.name} className={styles.entry}>
          <Row spaceBetween>
            <strong>{s.name}</strong>
            <Button variant="red" size="sm" onClick={() => remove(s.name)}>
              Delete
            </Button>
          </Row>
          <textarea
            className={styles.config}
            value={drafts[s.name] ?? ''}
            onChange={(e) => setDrafts((d) => ({ ...d, [s.name]: e.target.value }))}
            rows={4}
          />
          <Button className={styles.saveBtn} disabled={busy} onClick={() => save(s.name)}>
            Save
          </Button>
        </div>
      ))}

      <div className={styles.entry}>
        <Muted className={styles.addLabel}>Add an MCP server</Muted>
        <input
          className={styles.nameInput}
          placeholder="name (e.g. github)"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
        />
        <textarea
          className={styles.config}
          value={newConfig}
          onChange={(e) => setNewConfig(e.target.value)}
          rows={4}
        />
        <Button className={styles.saveBtn} variant="primary" disabled={busy || !newName.trim()} onClick={add}>
          Add
        </Button>
      </div>

      {error && <ErrorText className={styles.error}>{error}</ErrorText>}
    </Card>
  );
}
