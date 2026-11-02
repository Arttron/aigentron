// Updating the extension in place: what is allowed, what to write, and the writing itself (through a folder handle the person gave once).
import { compareVersions } from './version.js';

const SORT = (a) => [...(a ?? [])].sort();
const subset = (a, b) => SORT(a).every((x) => (b ?? []).includes(x));

/**
 * May the new package replace the running one WITHOUT the person reinstalling it? Same identity (key), a newer version, and no new powers
 * (permissions, host permissions, optional host permissions must not grow). Anything else is a manual update.
 */
export function checkCompatible(oldM, newM) {
  const reasons = [];
  if (!newM || typeof newM !== 'object') return { ok: false, reasons: ['the new package has no manifest'] };
  if (newM.manifest_version !== 3) reasons.push('the new package is not a Manifest V3 extension');
  if (oldM.key && newM.key !== oldM.key) reasons.push('the new package belongs to a different extension (its key differs — a different server?)');
  if (compareVersions(newM.version ?? '0', oldM.version ?? '0') <= 0) reasons.push('the new package is not newer than the installed one');
  if (!subset(newM.permissions, oldM.permissions)) reasons.push(`it asks for new permissions: ${SORT(newM.permissions).filter((x) => !(oldM.permissions ?? []).includes(x)).join(', ')}`);
  if (!subset(newM.host_permissions, oldM.host_permissions)) reasons.push('it asks for access to new addresses');
  if (!subset(newM.optional_host_permissions, oldM.optional_host_permissions)) reasons.push('it asks for new optional access');
  return { ok: reasons.length === 0, reasons };
}

/** The order of writing and the files to remove: everything but the manifest first, the manifest LAST (a failure half-way leaves the old manifest in charge). */
const SAFE_NAME = (n) => typeof n === 'string' && n.length > 0 && n.length < 200 && !n.startsWith('/') && !n.includes('\\') && n.split('/').every((p) => p && p !== '.' && p !== '..' && !p.includes('\0'));
const EXT_FILE = /\.(js|html|css|png|json|svg)$/i;

/**
 * Only the files of an extension may be removed, and only where the new package has its own: at the top level, or in a folder the new
 * package also fills (lib/, icons/). Anything else in the person's folder (notes, a .git, other projects) is left alone.
 */
export function planUpdate(newFiles, existingNames) {
  const names = [...newFiles.keys()];
  const bad = names.find((n) => !SAFE_NAME(n));
  if (bad !== undefined) throw new Error(`The package holds a file name that is not allowed: ${String(bad).slice(0, 60)}`);
  const dirs = new Set(names.map((n) => n.split('/').slice(0, -1).join('/')));
  const write = [...names.filter((n) => n !== 'manifest.json').sort(), ...names.filter((n) => n === 'manifest.json')];
  const keep = new Set(names);
  const remove = [...existingNames].filter((n) => !keep.has(n) && SAFE_NAME(n) && EXT_FILE.test(n) && dirs.has(n.split('/').slice(0, -1).join('/'))).sort();
  return { write, remove };
}

/** Every file of a folder (relative paths) through a FileSystemDirectoryHandle. */
export async function listFiles(dir, prefix = '') {
  const out = [];
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind === 'directory') out.push(...(await listFiles(handle, `${prefix}${name}/`)));
    else out.push(`${prefix}${name}`);
  }
  return out;
}

async function dirFor(root, path, create) {
  let d = root;
  for (const part of path.split('/').slice(0, -1)) d = await d.getDirectoryHandle(part, { create });
  return d;
}

/** Writes the new files into the folder, then removes the files that are gone. Returns what was done. */
export async function applyUpdate(root, newFiles, existingNames) {
  const { write, remove } = planUpdate(newFiles, existingNames);
  for (const path of write) {
    const dir = await dirFor(root, path, true);
    const file = await dir.getFileHandle(path.split('/').pop(), { create: true });
    const w = await file.createWritable();
    await w.write(newFiles.get(path));
    await w.close();
  }
  for (const path of remove) {
    try {
      await (await dirFor(root, path, false)).removeEntry(path.split('/').pop());
    } catch {
      /* already gone */
    }
  }
  return { written: write.length, removed: remove.length };
}
