/**
 * "Is this path inside one of the allowed folders?" — the one implementation behind the media tools, the task attachments, the
 * resource library and the workspace (there used to be five). Two levels:
 *  - `insideRoot`: a pure string check (no `..`, prefix match on whole path segments, an empty root never matches anything);
 *  - `realInside` / `realAncestorInside`: the same check on REAL paths (symlinks followed on both sides), so a link that leads out
 *    of a root is refused and a root that is itself a symlink still works.
 */
import { realpath, stat } from 'node:fs/promises';
import { basename, dirname, resolve, sep } from 'node:path';

const norm = (p: string): string => p.replace(/\/+$/, '');

/** A path is only usable inside one of the roots (no `..`, no sibling folders that merely share a prefix). Pure string check. */
export function insideRoot(path: string, roots: readonly string[]): boolean {
  const p = norm(path);
  if (p.split('/').includes('..')) return false;
  return roots.some((r) => {
    const n = norm(r);
    return n !== '' && (p === n || p.startsWith(`${n}${sep}`)); // an empty root must never allow everything
  });
}

/** The real paths of the roots (a root that does not exist yet keeps its resolved path); empty roots are dropped. */
export async function realRoots(roots: readonly string[]): Promise<string[]> {
  return Promise.all(roots.filter(Boolean).map((r) => realpath(r).catch(() => resolve(r))));
}

/**
 * The real path of `path` when it exists AND really sits inside one of the roots (symlinks resolved on both sides); null otherwise.
 * With `file: true` it must also be a regular file.
 */
export async function realInside(path: string, roots: readonly string[], opts: { file?: boolean } = {}): Promise<string | null> {
  const real = await realpath(path).catch(() => null);
  if (!real || !insideRoot(real, await realRoots(roots))) return null;
  if (opts.file) {
    const st = await stat(real).catch(() => null);
    if (!st?.isFile()) return null;
  }
  return real;
}

/**
 * For a path that may not exist yet (an upload target): its deepest EXISTING ancestor must really be inside one of the roots —
 * i.e. no symlink along the way leads out. True when nothing of the path exists at all (the roots themselves decide then).
 */
export async function realAncestorInside(path: string, roots: readonly string[]): Promise<boolean> {
  const real = await realRoots(roots);
  let probe = path;
  for (;;) {
    const r = await realpath(probe).catch(() => null);
    if (r) return insideRoot(r, real);
    const up = dirname(probe);
    if (up === probe) return true;
    probe = up;
  }
}

/**
 * Reduce an upload name to a safe base name: letters / digits / marks of ANY script stay (a photo called "кухня 2.jpg" or "写真.jpg"
 * must stay readable), path and odd characters become `_`, never a leading dot (a user file can never be `.links.json` or hide as a
 * dotfile), at most 120 characters, "file" when nothing is left.
 */
export function safeName(rawName: string): string {
  const base = basename(rawName).normalize('NFC').replace(/[^\p{L}\p{N}\p{M}.\-_ ]+/gu, '_').trim().replace(/^[.\s]+/, '');
  return base.length ? base.slice(0, 120) : 'file';
}

/** Files that hold secrets (sign-in tokens, env files): never readable or copied by agents' file tools, wherever they sit. */
export function isSecretPath(path: string): boolean {
  const parts = path.split('/').filter(Boolean);
  if (parts.some((s) => s === 'auth.json' || s === '.codex-home' || /^\.env(\.|$)/.test(s))) return true;
  const i = parts.indexOf('codex-home');
  return i >= 0 && parts[i + 1] !== 'generated_images';
}
