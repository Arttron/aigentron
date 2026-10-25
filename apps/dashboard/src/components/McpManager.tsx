import { useCallback, useEffect, useState } from 'react';
import { useMemo } from 'react';
import { describeMcpServer, parseMcpInput, type ParsedMcpInput } from '@lds/shared';
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

  // A saved server's own JSON; any of the usual formats is accepted when it holds exactly one server.
  const parse = (text: string): Record<string, unknown> => {
    const r = parseMcpInput(text);
    if (r.servers.length !== 1) throw new Error('This holds several servers — save one server here, add the others as new servers below.');
    return r.servers[0]!.config;
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

  // What the pasted text means (any client's format): shown under the box and used by Add.
  const understood = useMemo((): { ok: true; value: ParsedMcpInput } | { ok: false; error: string } | null => {
    if (!newConfig.trim() || newConfig === EXAMPLE) return null;
    try {
      return { ok: true, value: parseMcpInput(newConfig) };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }, [newConfig]);
  // one server: the typed name wins over the one found in the text; several: the names come from the text
  const toAdd = useMemo(() => {
    if (understood?.ok !== true) return [];
    const list = understood.value.servers;
    return list.map((sv) => ({ name: (list.length === 1 ? newName.trim() || sv.name : sv.name)?.trim() ?? '', config: sv.config, raw: sv }));
  }, [understood, newName]);
  const nameOk = toAdd.length > 0 && toAdd.every((x) => /^[\w-]+$/.test(x.name) && x.name.length <= 60);

  const add = () => {
    if (!nameOk) return;
    void run(async () => {
      for (const sv of toAdd) await api.createMcp({ name: sv.name, config: sv.config });
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
          <Button className={styles.saveBtn} disabled={busy} onClick={() => discover(s.name)} title="Connect to the server and read its tools' read-only annotations">
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
          placeholder={toAdd.length === 1 && toAdd[0]!.raw.name ? `name (found in the text: ${toAdd[0]!.raw.name})` : 'name (e.g. github)'}
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
        />
        <textarea
          className={styles.config}
          value={newConfig}
          onChange={(e) => setNewConfig(e.target.value)}
          rows={6}
          spellCheck={false}
          placeholder={'Paste what the server\'s page gives you: {"mcpServers": {…}}, {"url": …}, a "claude mcp add …" command or a URL'}
        />
        {understood?.ok === false && <ErrorText>{understood.error}</ErrorText>}
        {understood?.ok === true && (
          <Muted role="status">
            ✓ Understood {understood.value.servers.length === 1 ? 'one server' : `${understood.value.servers.length} servers`}:
            {toAdd.map((x, i) => (
              <div key={i}>
                {describeMcpServer({ name: x.name || x.raw.name, config: x.config })}
              </div>
            ))}
            {understood.value.notes.length > 0 && <div>{understood.value.notes.join(' · ')}</div>}
            <div>The pasted token is stored in this config (admins can read it). Use <code>${'{'}KEY{'}'}</code> to take it from a secret instead.</div>
          </Muted>
        )}
        <Row>
          <Button
            className={styles.saveBtn}
            variant="primary"
            disabled={busy || !nameOk}
            title={nameOk ? undefined : 'Paste a config and give the server a name (letters, digits, - and _)'}
            onClick={add}
          >
            {toAdd.length > 1 ? `Add ${toAdd.length} servers` : 'Add'}
          </Button>
          {understood?.ok === true && !nameOk && <Muted>Give the server a name above (letters, digits, - and _).</Muted>}
        </Row>
      </div>

      {error && <ErrorText className={styles.error}>{error}</ErrorText>}
    </Card>
  );
}
