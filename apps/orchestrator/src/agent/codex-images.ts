import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const IMAGE = /\.(png|jpe?g|webp|gif)$/i;

/** Where Codex puts the pictures it generates: inside the run's own CODEX_HOME. */
export const codexImagesDir = (agentDir: string, taskId: string): string => join(agentDir, 'runs', taskId, 'codex-home', 'generated_images');

/** Image files under `dir` (any depth, oldest first); an absent folder is "none". */
export async function listGeneratedImages(dir: string, cap = 200): Promise<string[]> {
  const found: { path: string; mtime: number }[] = [];
  const visit = async (d: string, depth: number): Promise<void> => {
    if (found.length >= cap) return;
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (depth < 4) await visit(p, depth + 1);
      } else if (e.isFile() && IMAGE.test(e.name)) {
        const s = await stat(p).catch(() => null);
        if (s) found.push({ path: p, mtime: s.mtimeMs });
      }
    }
  };
  await visit(dir, 0);
  return found.sort((a, b) => a.mtime - b.mtime).map((f) => f.path);
}
