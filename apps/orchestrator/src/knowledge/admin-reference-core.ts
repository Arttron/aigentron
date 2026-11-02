// The administrator's reference as knowledge-base documents: each shipped guide (agent/skills/core/admin/*.md) is cut into one document per
// `##` section, so a search finds the exact passage instead of the whole 45 KB being in every prompt. Pure — no database, no files.

export interface RefDoc {
  /** `dashboard-guide: Add-ons (/addons …)` — what the index and a search hit show. */
  title: string;
  text: string;
  /** The file it came from, relative to the agent directory. */
  source: string;
}

/** The name of the base (letters, digits, dash — a valid knowledge-base name). */
export const ADMIN_REFERENCE_KB = 'admin-reference';

const FRONTMATTER = /^---\n[\s\S]*?\n---\n?/;

/** The chunking of the reference base: small passages, so a hit shows the whole answer (a hit of this base is not cut short). */
export const ADMIN_REFERENCE_CHUNKING = { strategy: 'section', maxChars: 1200, overlap: 100, minChars: 40 } as const;

/** A long section of «cards» (`- *Name*: …`) → one part per card, so a search finds the card itself. */
function splitCards(text: string): { label: string; text: string }[] {
  const lines = text.split('\n');
  const parts: { label: string; lines: string[] }[] = [{ label: '', lines: [] }];
  let inFence = false;
  for (const line of lines) {
    if (/^```/.test(line)) inFence = !inFence;
    // a card (`- *Name*: …`) or a recipe (`**Name.** …`) starts with its bold name
    const m = !inFence && /^(?:- )?\*{1,2}([^*]{2,70}?)\*{1,2}/.exec(line);
    if (m) parts.push({ label: m[1]!.replace(/[.:]+$/, '').trim(), lines: [line] });
    else parts[parts.length - 1]!.lines.push(line);
  }
  return parts.map((p) => ({ label: p.label, text: p.lines.join('\n').trim() })).filter((p) => p.text.length > 0);
}

/** One guide → documents: the text before the first `##` (the overview) and one per `##` section, each led by its own heading. */
export function splitGuide(file: string, markdown: string): RefDoc[] {
  const name = file.replace(/\.md$/, '');
  const body = markdown.replace(/\r\n?/g, '\n').replace(FRONTMATTER, '').trim();
  const lines = body.split('\n');
  const docs: RefDoc[] = [];
  let heading = 'Overview';
  let buf: string[] = [];
  let inFence = false;
  const flush = () => {
    const text = buf.join('\n').trim();
    // a section with only its heading line carries nothing to find
    if (text.replace(/^#+.*$/m, '').trim().length <= 20) {
      buf = [];
      return;
    }
    const source = `skills/core/admin/${file}`;
    const parts = text.length > 1800 ? splitCards(text) : [];
    if (parts.length > 2) {
      // the section's own heading leads every part, so a card keeps its context; the lead-in (before the first card) is a part of its own
      for (const p of parts) {
        // a lead-in that is only the heading (the cards follow at once) carries nothing
        if (!p.label && p.text.replace(/^#+.*$/gm, '').trim().length < 40) continue;
        const label = p.label ? ` › ${p.label}` : '';
        docs.push({ title: `${name}: ${heading.slice(0, 70)}${label}`.slice(0, 140), text: p.label ? `## ${heading}\n${p.text}` : p.text, source });
      }
    } else docs.push({ title: `${name}: ${heading.slice(0, 100)}`, text, source });
    buf = [];
  };
  for (const line of lines) {
    if (/^```/.test(line)) inFence = !inFence;
    const h = !inFence && /^##\s+(.+?)\s*$/.exec(line);
    if (h) {
      flush();
      heading = h[1]!.replace(/[`*_]/g, '');
      buf.push(line);
    } else if (!inFence && /^#\s+/.test(line) && !docs.length && !buf.length) {
      heading = 'Overview'; // the file's own title is part of the overview
      buf.push(line);
    } else buf.push(line);
  }
  flush();
  return docs;
}

/** The compact table of contents the administrator keeps in its prompt: file, then its sections. Deterministic (the prompt must not change between runs). */
export function buildReferenceIndex(titles: readonly string[]): string {
  const by = new Map<string, string[]>();
  for (const t of [...titles].sort()) {
    const i = t.indexOf(': ');
    const file = i > 0 ? t.slice(0, i) : 'other';
    (by.get(file) ?? by.set(file, []).get(file)!).push(i > 0 ? t.slice(i + 2) : t);
  }
  const lines = [...by.entries()].map(([file, heads]) => `- **${file}**: ${heads.join(' · ')}`);
  return [
    '# Your reference (search it — do not answer from memory)',
    `Your guides are not in this prompt: they are the knowledge base "${ADMIN_REFERENCE_KB}". The passages of the guides that match the person's message are attached to it (under «Passages from your reference»): answer from them and from your tools. If they do not cover the question, call \`kb_search\` ONCE ({ "query": "…", "kb": "${ADMIN_REFERENCE_KB}" }; English, the exact words of the feature), then answer — do not keep searching. If nothing covers it, say you are not sure and check with a tool — never invent a parameter, flag or path.`,
    'What the reference covers (file: sections):',
    ...lines,
  ].join('\n');
}
