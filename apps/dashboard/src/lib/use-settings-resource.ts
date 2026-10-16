import { useCallback, useEffect, useRef, useState } from 'react';
import { API_BASE } from './config';

export type Msg = { ok: boolean; text: string };

/** busy + a one-line result message around an async action: `run(fn)` shows the returned text, or the error. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg | null>(null);
  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setMsg(null);
    try {
      setMsg({ ok: true, text: await fn() });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return { busy, setBusy, msg, setMsg, run };
}

/**
 * A server-side settings card: GET `path` into `info` (ignored after unmount), and `call()` for the PUT/POST that answers
 * `{ ok, error? }` — it sets busy/msg, then reloads. `onLoad` copies the loaded data into the form's draft state.
 */
export function useSettingsResource<T>(path: string, onLoad?: (info: T) => void) {
  const [info, setInfo] = useState<T | null>(null);
  const { busy, setBusy, msg, setMsg } = useAction();
  const alive = useRef(true);
  const onLoadRef = useRef(onLoad);
  onLoadRef.current = onLoad;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    const r = await fetch(`${API_BASE}${path}`, { cache: 'no-store' }).catch(() => null);
    if (!r?.ok) return;
    const j = (await r.json()) as T;
    if (!alive.current) return;
    setInfo(j);
    onLoadRef.current?.(j);
  }, [path]);
  useEffect(() => {
    void load();
  }, [load]);

  /** Sends the change; returns true on success (after reloading). */
  const call = async (subPath: string, method: string, body?: unknown, okText = 'Saved.'): Promise<boolean> => {
    setBusy(true);
    setMsg(null);
    const r = await fetch(`${API_BASE}${path}${subPath}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).catch(() => null);
    const j = (await r?.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (alive.current) setBusy(false);
    if (!r?.ok || j.ok === false) {
      if (alive.current) setMsg({ ok: false, text: j.error ?? 'Could not save.' });
      return false;
    }
    if (alive.current) setMsg({ ok: true, text: okText });
    await load();
    return true;
  };

  return { info, load, call, busy, setBusy, msg, setMsg };
}
