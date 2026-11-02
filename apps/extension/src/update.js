// Updates the extension in place: download the new package from this server, unzip it, write it over the folder the extension runs from (the person
// points at that folder once; the browser remembers it), and reload. Nothing is installed from anywhere else, and a package that asks for more power
// than the running one is refused (that one is a manual update).
import { apiBlob } from './lib/api.js';
import { getConfig, getConnection } from './lib/store.js';
import { applyUpdate, checkCompatible, listFiles } from './lib/update-core.js';
import { readZip } from './lib/unzip.js';
import { updateAvailable } from './lib/version.js';

const $ = (id) => document.getElementById(id);
const state = $('state');
function el(tag, props = {}, ...kids) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
}

// ---- the remembered folder (IndexedDB holds the handle) ----------------------------------------------------------------------------------
const db = () => new Promise((res, rej) => { const r = indexedDB.open('aigentron-update', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const kv = async (mode, fn) => { const d = await db(); return new Promise((res, rej) => { const t = d.transaction('kv', mode); const out = fn(t.objectStore('kv')); t.oncomplete = () => res(out.result); t.onerror = () => rej(t.error); }); };
const getHandle = () => kv('readonly', (s) => s.get('dir'));
const setHandle = (h) => kv('readwrite', (s) => s.put(h, 'dir'));

function show(...nodes) {
  state.replaceChildren(...nodes);
}
const p = (text, cls = 'muted') => el('p', { className: cls, textContent: text });

async function folderLooksRight(dir) {
  try {
    const m = JSON.parse(await (await (await dir.getFileHandle('manifest.json')).getFile()).text());
    return m.key === chrome.runtime.getManifest().key || m.name === chrome.runtime.getManifest().name;
  } catch {
    return false;
  }
}

async function run(dir, available) {
  show(p('Downloading the new version…'));
  const cfg = await getConfig();
  const zip = await apiBlob(`/api/extension/package?origins=${encodeURIComponent(cfg.origins.join(','))}`);
  const files = await readZip(zip);
  const newManifest = JSON.parse(new TextDecoder().decode(files.get('manifest.json') ?? new Uint8Array()));
  const ok = checkCompatible(chrome.runtime.getManifest(), newManifest);
  if (!ok.ok) {
    $('how').hidden = false;
    return show(p('This update cannot be applied automatically:', 'bad'), el('ul', {}, ...ok.reasons.map((r) => el('li', { textContent: r }))), p('Use the manual update below.'));
  }
  show(p(`Writing version ${newManifest.version}…`));
  const existing = await listFiles(dir);
  const r = await applyUpdate(dir, files, existing);
  show(p(`Updated to ${newManifest.version} (${r.written} files). The extension reloads now.`, 'ok'));
  setTimeout(() => chrome.runtime.reload(), 800);
  void available;
}

async function init() {
  const conn = await getConnection();
  if (!conn) return show(p('The extension is not connected to a server.', 'bad'));
  const { extensionVersion } = await fetch(`${conn.origin}/api/extension/me`, { headers: { authorization: `Bearer ${conn.token}` } }).then((r) => r.json()).catch(() => ({}));
  const installed = chrome.runtime.getManifest().version;
  if (!updateAvailable(installed, extensionVersion)) return show(p(`You have the latest version (${installed}).`, 'ok'));
  $('how').hidden = false;
  if (typeof window.showDirectoryPicker !== 'function') return show(p(`Version ${extensionVersion} is available (you have ${installed}). This browser cannot write to a folder — update manually.`));
  let dir = await getHandle().catch(() => null);
  const go = el('button', { className: 'primary', textContent: `Update ${installed} → ${extensionVersion}` });
  const err = el('div', { className: 'bad' });
  go.onclick = async () => {
    go.disabled = true;
    err.textContent = '';
    try {
      if (!dir) {
        dir = await window.showDirectoryPicker({ id: 'aigentron-extension', mode: 'readwrite' });
        if (!(await folderLooksRight(dir))) {
          dir = null;
          throw new Error('That folder does not hold this extension (no matching manifest.json). Choose the folder you loaded in chrome://extensions.');
        }
        await setHandle(dir);
      }
      if ((await dir.requestPermission({ mode: 'readwrite' })) !== 'granted') throw new Error('Writing to the folder was not allowed.');
      await run(dir, extensionVersion);
    } catch (e) {
      err.textContent = e.name === 'AbortError' ? '' : e.message;
      go.disabled = false;
    }
  };
  show(
    p(`Version ${extensionVersion} is available (you have ${installed}).`, ''),
    dir ? p('The extension folder is remembered; the browser may ask once to allow writing.') : p('First time: choose the folder you loaded in chrome://extensions (the one you unzipped the extension into). The browser asks to allow writing there.'),
    go,
    err,
  );
}

init().catch((e) => show(p(e.message ?? String(e), 'bad')));
