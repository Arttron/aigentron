/**
 * Alert sounds the person uploaded. They stay in THIS browser (IndexedDB), like every other alert-sound setting: nothing is sent to the server. A sound is
 * a short audio file (mp3, wav, ogg, m4a …), at most 1 MB and 15 seconds; at most five.
 */

export const CUSTOM_PREFIX = 'custom:';
export const MAX_CUSTOM_SOUNDS = 5;
export const MAX_SOUND_BYTES = 1024 * 1024;
export const MAX_SOUND_SECONDS = 15;

export interface CustomSound {
  id: string;
  name: string;
  size: number;
}

const AUDIO_EXT = /\.(mp3|wav|ogg|oga|opus|m4a|aac|webm|flac)$/i;

/** Is this file acceptable as an alert sound (before it is decoded)? Returns what is wrong, or null. */
export function validateSoundFile(file: { name: string; size: number; type: string }, existing: number): string | null {
  if (existing >= MAX_CUSTOM_SOUNDS) return `You can keep ${MAX_CUSTOM_SOUNDS} sounds — remove one first.`;
  if (!file.type.startsWith('audio/') && !AUDIO_EXT.test(file.name)) return 'That is not an audio file (use mp3, wav, ogg or m4a).';
  if (file.size > MAX_SOUND_BYTES) return `The file is ${(file.size / 1024).toFixed(0)} KB — a sound may be at most ${MAX_SOUND_BYTES / 1024} KB.`;
  if (file.size === 0) return 'The file is empty.';
  return null;
}

/** The id of a custom sound inside a sound name (`custom:ab12…` → `ab12…`), or null for a built-in one. */
export const customIdOf = (name: string): string | null => (name.startsWith(CUSTOM_PREFIX) ? name.slice(CUSTOM_PREFIX.length) : null);

export const isCustomName = (name: unknown): name is `custom:${string}` => typeof name === 'string' && /^custom:[\w-]{4,40}$/.test(name);

// ---- storage ---------------------------------------------------------------------------------------------------------------------

const DB = 'lds-alert-sounds';
const STORE = 'sounds';

interface Row extends CustomSound {
  data: ArrayBuffer;
}

/** Where sounds live when IndexedDB is not available (a private window): until the page is closed. */
const memory = new Map<string, Row>();

function open(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function run<T>(db: IDBDatabase, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = fn(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function listCustomSounds(): Promise<CustomSound[]> {
  const db = await open();
  const rows: Row[] = db ? await run<Row[]>(db, 'readonly', (s) => s.getAll()).catch(() => []) : [...memory.values()];
  return rows.map(({ id, name, size }) => ({ id, name, size })).sort((a, b) => a.name.localeCompare(b.name));
}

export async function getCustomSoundData(id: string): Promise<ArrayBuffer | null> {
  const db = await open();
  const row = db ? await run<Row | undefined>(db, 'readonly', (s) => s.get(id)).catch(() => undefined) : memory.get(id);
  return row?.data ?? null;
}

export async function saveCustomSound(name: string, data: ArrayBuffer): Promise<CustomSound> {
  const id = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const row: Row = { id, name: name.replace(/\.[^.]+$/, '').slice(0, 40) || 'Sound', size: data.byteLength, data };
  const db = await open();
  if (db) await run(db, 'readwrite', (s) => s.put(row)).catch(() => memory.set(id, row));
  else memory.set(id, row);
  return { id, name: row.name, size: row.size };
}

export async function removeCustomSound(id: string): Promise<void> {
  memory.delete(id);
  const db = await open();
  if (db) await run(db, 'readwrite', (s) => s.delete(id)).catch(() => undefined);
}
