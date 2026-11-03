export type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

/** What a vision model is asked to write down about a screenshot of a page. */
export const SHOT_QUESTION =
  'This is a screenshot of a web page. Write out everything useful that is visible, exactly as shown: the title, names, ratings, number of reviews, number of users or installs, prices, versions, dates, permissions, the description, tabs and section headings. Numbers exactly as written. If something is cut off or not visible, say so; do not guess.';

export interface PageData {
  text?: string;
  url?: string;
  title?: string;
  tabId?: number;
  more?: boolean;
  offset?: number;
  note?: string;
  image?: string;
}

/**
 * The answer of a page tool: the outline / text (marked as untrusted), the extension's note when the page could not be scripted, and — when the page source
 * gave almost nothing and a picture was taken — what a vision model read off it, or (no vision model) the picture itself for the agent to look at.
 */
export async function pageContent(o: PageData, untrusted: string, read: (image: string, question: string) => Promise<string | null>): Promise<{ content: Content[] }> {
  const head = `${o.tabId !== undefined ? `Tab ${o.tabId}` : 'Page'}${o.title ? ` — ${o.title}` : ''}${o.url ? ` (${o.url})` : ''}`;
  const body = `${untrusted}${String(o.text ?? '').slice(0, 24_000)}${o.more ? `\n[more text follows: call browser_read with offset ${o.offset ?? 0}]` : ''}`;
  const note = o.note ? `\n[${o.note}]` : '';
  if (!o.image) return { content: [{ type: 'text', text: `${head}${note}\n${body}` }] };
  const seen = await read(o.image, SHOT_QUESTION);
  if (seen) return { content: [{ type: 'text', text: `${head}${note}\n${body}\n\n## Read from a screenshot of the page (by a vision model)\n${untrusted}${seen.slice(0, 8000)}` }] };
  return { content: [{ type: 'text', text: `${head}${note}\n${body}\n\n(A screenshot of the page is attached.)` }, { type: 'image', data: o.image, mimeType: 'image/jpeg' }] };
}
