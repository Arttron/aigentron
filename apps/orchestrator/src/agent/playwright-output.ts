import { basename, isAbsolute, join } from 'node:path';

/**
 * A screenshot the agent saved with the Playwright tool (`browser_take_screenshot` with a `filename`) is written by the BROWSER's service, into its output
 * folder — not into the task. The agent names it as the tool reported it: a bare name («whoami.png»), or relative («output/whoami.png», «.playwright-mcp/whoami.png»).
 * This turns such a name into the file in the output folder (null for anything else: an absolute path, a path with `..`, a name that is not plain).
 */
export function playwrightOutputCandidate(p: string, outputDir: string): string | null {
  const v = String(p ?? '').trim();
  if (!v || isAbsolute(v) || v.split('/').includes('..')) return null;
  const name = basename(v);
  if (!/^[\w][\w .()+-]{0,150}\.(png|jpe?g|webp|gif)$/i.test(name)) return null;
  return join(outputDir, name);
}
