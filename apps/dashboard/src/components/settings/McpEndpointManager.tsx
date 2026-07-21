'use client';

import { useEffect, useState } from 'react';
import { api, type McpHostStatus } from '@/lib/api';
import { ORCHESTRATOR_URL } from '@/lib/config';
import { Card, SectionTitle, Badge, Button, ErrorText } from '@/components/ui';
import styles from './McpEndpointManager.module.css';

/** A read-only mono field with a copy button. */
function CopyField({
  value,
  copied,
  onCopy,
}: {
  value: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className={styles.field}>
      <code className={styles.code}>{value}</code>
      <Button size="sm" className={styles.copyBtn} onClick={onCopy}>
        {copied ? '✓ Copied' : 'Copy'}
      </Button>
    </div>
  );
}

/**
 * Status + connection info for the hosted MCP entry point (POST/GET /api/mcp).
 * Read-only: the endpoint is configured via env (MCP_HOST_ENABLED / MCP_TOKEN /
 * MCP_ALLOWED_ORIGINS) and read at boot. The token value is never sent to the
 * browser — we only surface whether one is required and where to append it.
 */
export function McpEndpointManager() {
  const [status, setStatus] = useState<McpHostStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const url = `${ORCHESTRATOR_URL}/api/mcp`;

  const refresh = () =>
    api
      .getMcpStatus()
      .then(setStatus)
      .catch((e) => setError((e as Error).message));

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000); // keep the live session count fresh
    return () => clearInterval(t);
  }, []);

  const copy = (id: string, text: string) => {
    void navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(id);
        setTimeout(() => setCopied((c) => (c === id ? null : c)), 1500);
      },
      () => undefined,
    );
  };

  const suffix = status?.tokenRequired ? '?key=<MCP_TOKEN>' : '';
  const endpoint = url + suffix;
  const codeCmd = `claude mcp add --transport http lds-fleet ${url}`;

  return (
    <Card>
      <SectionTitle>MCP endpoint</SectionTitle>
      <p className={styles.intro}>
        Lets an external MCP client (Claude Desktop, Claude Code, a browser client) create and track
        tasks on the fleet, and read the project&apos;s markdown docs (<code>doc://</code> resources,
        or the <code>list_docs</code>/<code>read_doc</code> tools) for context. Configured via env —
        this tab is read-only.
      </p>

      {error && <ErrorText>{error}</ErrorText>}

      {status && (
        <>
          <div className={styles.panel}>
            <div className={styles.stat}>
              <span className={styles.statLabel}>Status</span>
              <span className={styles.statValue}>
                <Badge tone={status.enabled ? 'done' : 'failed'}>
                  {status.enabled ? 'enabled' : 'disabled'}
                </Badge>
              </span>
            </div>
            <div className={styles.stat}>
              <span className={styles.statLabel}>Auth</span>
              <span className={styles.statValue}>
                <Badge tone={status.tokenRequired ? 'done' : 'stalled'}>
                  {status.tokenRequired ? 'token required' : 'open · no token'}
                </Badge>
              </span>
            </div>
            <div className={styles.stat}>
              <span className={styles.statLabel}>Active sessions</span>
              <span className={styles.statValue}>
                <Badge tone="neutral">{status.activeSessions}</Badge>
              </span>
            </div>
            <div className={styles.stat}>
              <span className={styles.statLabel}>Allowed origins</span>
              <span className={styles.statValue} title={status.allowedOrigins.join(', ')}>
                {status.allowedOrigins.length ? status.allowedOrigins.join(', ') : 'any'}
              </span>
            </div>
          </div>

          {!status.tokenRequired && (
            <p className={styles.warn}>
              ⚠ No token set. Fine for localhost, but before exposing this (e.g. via ngrok for
              claude.ai) set <code>MCP_TOKEN</code> in <code>.env</code> and restart — a public URL
              without a token lets anyone drive your fleet.
            </p>
          )}

          <div className={styles.section}>
            <SectionTitle>Connect</SectionTitle>

            <div className={styles.method}>
              <span className={styles.methodLabel}>🔌 Endpoint URL</span>
              <CopyField value={endpoint} copied={copied === 'url'} onCopy={() => copy('url', endpoint)} />
            </div>

            <div className={styles.method}>
              <span className={styles.methodLabel}>⌨️ Claude Code</span>
              <CopyField value={codeCmd} copied={copied === 'cli'} onCopy={() => copy('cli', codeCmd)} />
            </div>

            <div className={styles.method}>
              <span className={styles.methodLabel}>🖥️ Claude Desktop</span>
              <p className={styles.hint}>
                Settings → Connectors → Add custom connector → paste the endpoint URL above.
              </p>
            </div>

            <div className={styles.method}>
              <span className={styles.methodLabel}>🌐 claude.ai (web) — via a tunnel</span>
              <p className={styles.hint}>
                claude.ai connects from Anthropic&apos;s servers, so it needs a public HTTPS URL. Run{' '}
                <code>ngrok http 3001</code> and use{' '}
                <code>https://&lt;sub&gt;.ngrok-free.app/api/mcp{suffix}</code>
                {status.tokenRequired
                  ? ' — the ?key= form carries the token since claude.ai can’t send custom headers.'
                  : ' — set MCP_TOKEN first, then append ?key=<token>.'}
              </p>
            </div>
          </div>

          <p className={styles.docs}>
            Full guide: <code>docs/mcp-entry-point.md</code>
          </p>
        </>
      )}
    </Card>
  );
}
