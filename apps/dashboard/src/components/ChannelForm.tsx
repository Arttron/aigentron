import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type AgentInfo, type ChannelInfo, type ChannelInput, type ChannelKindMeta, type ProbedSender } from '@/lib/api';
import { Field, Row, Button, Muted, ErrorText } from '@/components/ui';
import styles from './ChannelForm.module.css';

/**
 * Add/edit form for a channel, rendered inside a modal. The channel kind is
 * picked from the registry (only `available` kinds are selectable; planned ones
 * are shown disabled), and the config inputs are generated from that kind's
 * field schema — so new kinds need no form changes here.
 */
export function ChannelForm({
  initial,
  kinds,
  onSubmit,
  onCancel,
}: {
  initial?: ChannelInfo;
  kinds: ChannelKindMeta[];
  onSubmit: (values: ChannelInput) => Promise<void>;
  onCancel: () => void;
}) {
  const isNew = !initial;
  const firstAvailable = kinds.find((k) => k.available)?.kind ?? '';
  const [name, setName] = useState(initial?.name ?? '');
  const [kind, setKind] = useState(initial?.kind ?? firstAvailable);
  // Per-field text values (list fields held as comma-separated strings).
  const [values, setValues] = useState<Record<string, string>>(() => initialValues(initial));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentInfo[]>([]);

  const def = useMemo(() => kinds.find((k) => k.kind === kind), [kinds, kind]);
  // Load the agent list only if this kind has an agent-picker field.
  const needsAgents = def?.fields.some((f) => f.type === 'agent') ?? false;
  useEffect(() => {
    if (needsAgents) api.listAgents().then(setAgents).catch(() => undefined);
  }, [needsAgents]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !def) return;
    setBusy(true);
    setError(null);
    try {
      const config: Record<string, unknown> = {};
      for (const f of def.fields) {
        const raw = (values[f.key] ?? '').trim();
        if (f.type === 'list') config[f.key] = raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : [];
        else if (raw) config[f.key] = raw; // blank secret/text → omit (keeps stored on edit)
      }
      await onSubmit({ name: name.trim(), kind, config });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const set = (key: string, v: string) => setValues((s) => ({ ...s, [key]: v }));
  /** Put an id on the allow-list field (no duplicates). */
  const addAllowed = (id: string) =>
    setValues((s) => {
      const have = (s.allowedChatIds ?? '').split(',').map((x) => x.trim()).filter(Boolean);
      return { ...s, allowedChatIds: have.includes(id) ? have.join(', ') : [...have, id].join(', ') };
    });

  return (
    <form onSubmit={submit}>
      {isNew && (
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. telegram-main" />
        </Field>
      )}

      <Field label="Channel type">
        <select value={kind} onChange={(e) => setKind(e.target.value)} disabled={!isNew}>
          {kinds.map((k) => (
            <option key={k.kind} value={k.kind} disabled={!k.available}>
              {k.label}
              {k.available ? '' : ' — soon'}
            </option>
          ))}
        </select>
      </Field>

      {def?.hint && <Muted className={styles.hint}>{def.hint}</Muted>}

      {def?.fields.map((f) => {
        const secretState = initial?.secrets?.[f.key];
        const label =
          f.secret && secretState?.set ? `${f.label} — set (${secretState.hint}); blank keeps it` : f.label;
        return (
          <Field key={f.key} label={label}>
            {f.type === 'agent' ? (
              <select value={values[f.key] ?? ''} onChange={(e) => set(f.key, e.target.value)}>
                <option value="">(default lead)</option>
                {agents.map((a) => (
                  <option key={a.name} value={a.name}>
                    {a.name}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type={f.secret ? 'password' : 'text'}
                value={values[f.key] ?? ''}
                onChange={(e) => set(f.key, e.target.value)}
                placeholder={f.secret && secretState?.set ? 'leave blank to keep' : f.placeholder}
              />
            )}
            {f.help && <Muted className={styles.help}>{f.help}</Muted>}
          </Field>
        );
      })}

      {def?.canProbe && <FindMyId kind={kind} channelId={initial?.id} values={values} def={def} hasStoredSecret={Object.values(initial?.secrets ?? {}).some((s) => s.set)} onAdd={(id) => addAllowed(id)} />}

      <Row>
        <Button variant="primary" type="submit" disabled={busy || !name.trim() || !def}>
          {busy ? 'Saving…' : isNew ? 'Add channel' : 'Save changes'}
        </Button>
        <Button onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        {error && <ErrorText>{error}</ErrorText>}
      </Row>
    </form>
  );
}

/** Seed form values from an existing channel (list → comma string; secrets blank). */
function initialValues(initial?: ChannelInfo): Record<string, string> {
  const out: Record<string, string> = {};
  if (!initial) return out;
  for (const [k, v] of Object.entries(initial.config ?? {})) {
    out[k] = Array.isArray(v) ? v.join(', ') : v == null ? '' : String(v);
  }
  return out;
}

const WAIT_ROUNDS = 5; // × ~20 s each

/**
 * "Find my id": once the account's key is in the form, press the button, write anything to the bot from your own account, and the message arrives here with
 * who wrote it — then one tap puts that id on the allow-list. Nothing is saved until the form is.
 */
function FindMyId({ kind, channelId, values, def, hasStoredSecret, onAdd }: { kind: string; channelId?: string; values: Record<string, string>; def: ChannelKindMeta; hasStoredSecret: boolean; onAdd: (id: string) => void }) {
  const [state, setState] = useState<'idle' | 'waiting' | 'found' | 'none'>('idle');
  const [who, setWho] = useState<ProbedSender | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState(false);
  const cancelled = useRef(false);

  const secretKey = def.fields.find((f) => f.secret)?.key;
  const keyReady = Boolean(secretKey && ((values[secretKey] ?? '').trim() || hasStoredSecret));
  const allowed = (values.allowedChatIds ?? '').split(',').map((x) => x.trim());

  useEffect(() => () => void (cancelled.current = true), []);

  const start = async () => {
    cancelled.current = false;
    setState('waiting');
    setError(null);
    setAdded(false);
    const config: Record<string, unknown> = {};
    for (const f of def.fields) {
      const raw = (values[f.key] ?? '').trim();
      if (f.type !== 'list' && f.type !== 'agent' && raw) config[f.key] = raw;
    }
    try {
      for (let i = 0; i < WAIT_ROUNDS && !cancelled.current; i++) {
        const r = await api.probeChannelSender({ kind, id: channelId, config, waitSeconds: 20 });
        if (r.found) {
          setWho(r);
          setState('found');
          return;
        }
      }
      if (!cancelled.current) setState('none');
    } catch (e) {
      setError((e as Error).message);
      setState('idle');
    }
  };

  return (
    <div className={styles.findId}>
      <strong>Find my id</strong>
      {state === 'idle' && (
        <>
          <Muted>
            {keyReady
              ? 'Press the button, then write any message to your bot from your own account — it shows up here with your id, and you can allow it with one tap.'
              : 'Enter the bot token above first; then you can find your id by writing to the bot.'}
          </Muted>
          <Button onClick={() => void start()} disabled={!keyReady}>
            Wait for my message
          </Button>
        </>
      )}
      {state === 'waiting' && (
        <>
          <Muted>⏳ Waiting… write any message to your bot in {def.label} now (up to 100 seconds).</Muted>
          <Button
            onClick={() => {
              cancelled.current = true;
              setState('idle');
            }}
          >
            Stop waiting
          </Button>
        </>
      )}
      {state === 'none' && (
        <>
          <Muted>Nothing arrived. Check that you wrote to the right bot, then try again.</Muted>
          <Button onClick={() => void start()}>Try again</Button>
        </>
      )}
      {state === 'found' && who && (
        <>
          <Muted role="status">
            📩 {who.userName ? <strong>{who.userName}</strong> : 'Someone'} wrote{who.chatTitle ? ` in “${who.chatTitle}”` : ''}: “{who.text.slice(0, 200)}”
            <br />
            {who.chatTitle ? 'Chat id' : 'Id'}: <code>{who.chatId}</code>
            {who.userId !== who.chatId ? <> (user id <code>{who.userId}</code>)</> : null}
          </Muted>
          {added || allowed.includes(who.chatId) ? (
            <Muted>✓ This id is in the allowed list{added ? ' (saved with the channel)' : ''}.</Muted>
          ) : (
            <>
              <Muted>Add this id to the allowed chats?</Muted>
              <Row>
                <Button
                  variant="primary"
                  onClick={() => {
                    onAdd(who.chatId);
                    setAdded(true);
                  }}
                >
                  Yes, allow it
                </Button>
                <Button onClick={() => setState('idle')}>No</Button>
              </Row>
            </>
          )}
          <Button onClick={() => void start()}>Find another</Button>
        </>
      )}
      {error && <ErrorText>{error}</ErrorText>}
    </div>
  );
}
