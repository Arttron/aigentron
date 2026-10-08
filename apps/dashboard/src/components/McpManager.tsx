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
  const [found, setFound] = useState<Record<string, { trusted: boolean; tools: { name: string; readOnly: boolean }[] }>>({});

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

  const discover = (name: string) =>
    run(async () => {
      const r = await api.discoverMcp(name);
      setFound((f) => ({ ...f, [name]: r }));
    });

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
        by name in their <code>mcp</code> field. Optional <code>"readOnlyTools": ["*"]</code> (or a list of tool
        names) in a config marks a trusted server's tools as read-only, so they run without an approval on every
        call. Or set <code>"trustAnnotations": true</code> and press <em>Discover tools</em>: tools the server itself
        annotates as read-only (and not destructive) skip approvals; new or unannotated tools still ask. Remote servers over SSE are skipped by the Codex runtime (use <code>http</code> or stdio).
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
          <Button disabled={busy} onClick={() => discover(s.name)} title="Connect to the server and read its tools' read-only annotations">
            Discover tools
          </Button>
          {found[s.name] && (
            <Muted>
              {found[s.name]!.tools.length} tool(s); read-only by the server's own annotation:{' '}
              {found[s.name]!.tools.filter((t) => t.readOnly).map((t) => t.name).join(', ') || 'none'}.{' '}
              {found[s.name]!.trusted
                ? 'Those run without approval (trustAnnotations is on); everything else still asks.'
                : 'Not applied — add "trustAnnotations": true to this server\'s config to let them skip approval.'}
            </Muted>
          )}
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
        <Row>
          <Button
            className={styles.saveBtn}
            variant="primary"
            disabled={busy || !newName.trim()}
            title={newName.trim() ? undefined : 'Enter a server name first'}
            onClick={add}
          >
            Add
          </Button>
          {!newName.trim() && <Muted>Enter a server name above to enable Add.</Muted>}
        </Row>
      </div>

      {error && <ErrorText className={styles.error}>{error}</ErrorText>}
    </Card>
  );
}
