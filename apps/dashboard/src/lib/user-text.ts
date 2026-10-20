/**
 * A message the person wrote, split into plain text and fenced code blocks (``` … ```). Only fences are interpreted — the rest of what they
 * typed stays exactly as typed (no bold/italic/list guessing on their own words). An unclosed fence runs to the end (a half-typed block).
 */
export type UserSegment = { t: 'text'; v: string } | { t: 'code'; lang: string; v: string };

export function splitFences(src: string): UserSegment[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out: UserSegment[] = [];
  let text: string[] = [];
  const flush = () => {
    const v = text.join('\n').replace(/^\n+|\n+$/g, '');
    if (v) out.push({ t: 'text', v });
    text = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const open = /^(\s*)(`{3,})\s*([\w+#.-]*)\s*$/.exec(lines[i]!);
    if (!open) {
      text.push(lines[i]!);
      continue;
    }
    flush();
    const fence = open[2]!;
    const body: string[] = [];
    i++;
    // closes at a line of at least as many backticks and nothing else
    while (i < lines.length && !new RegExp(`^\\s*\`{${fence.length},}\\s*$`).test(lines[i]!)) body.push(lines[i++]!);
    out.push({ t: 'code', lang: open[3] ?? '', v: body.join('\n') });
  }
  flush();
  return out;
}

/** Does the message contain a fenced block at all (a plain message is rendered as before)? */
export const hasFence = (src: string): boolean => /^\s*`{3,}/m.test(src);
