/** Task names generated from the context — pure helpers (unit-tested). */

export const MAX_TITLE = 70;

/** First line of the request, cut to 80 — the name a task has until a better one is generated. */
/**
 * Whether a new task gets a generated title later. Only a task a PERSON created without naming it does (the dashboard, Telegram, an MCP client);
 * a title the creator gave is final, and a task created by an agent (a subtask, a task a lead or the admin starts, a scheduled job) keeps the
 * first line of its brief — no model call is spent naming work no person typed.
 */
export function titleStateFor(o: { given: boolean; byAgent?: boolean }): 'manual' | 'auto' {
  return o.given || o.byAgent ? 'manual' : 'auto';
}

export function fallbackTitle(prompt: string): string {
  const first = prompt.trim().split('\n')[0]?.trim() ?? '';
  const line = first || 'Untitled task';
  return line.length > 80 ? `${line.slice(0, 77)}…` : line;
}

/** A request that says too little to name the task from (the name has to wait for the first answer). */
export function isWeakPrompt(prompt: string): boolean {
  const p = prompt.trim();
  // a character of Chinese / Japanese / Korean carries about as much as 3 Latin ones
  const dense = (p.match(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/gu) ?? []).length;
  if (p.length + dense * 2 < 14) return true;
  if (/^(review|look at|see|check|open|read|посмотри|проверь|глянь|вот|это)\b.{0,40}\b(attach|file|photo|picture|image|video|прикреп|файл|фото|картинк|видео)/i.test(p) && p.length < 60) return true;
  return /^(hi|hello|hey|привет|здравствуй|добрый день|test|тест)\b/i.test(p) && p.length < 40;
}

const KIND = (name: string): string => (/\.(mp4|mov|m4v|webm|mkv|avi|3gp)$/i.test(name) ? 'video' : /\.(jpe?g|png|webp|gif|heic)$/i.test(name) ? 'image' : /\.pdf$/i.test(name) ? 'PDF' : 'file');

export const TITLE_SYSTEM =
  'You name tasks for a task list. Write ONE short title (3–8 words, at most 60 characters) that says what the task is about: the subject (product, file, topic) and the action. ' +
  'Use the same language as the request. No quotes, no markdown, no trailing period, no prefix such as "Title:". Output only the title.';

/** What the naming model is shown. */
export function buildTitleInput(o: { prompt: string; attachments?: string[]; agent?: string | null; answer?: string | null }): string {
  const parts = [`Request:\n${o.prompt.trim().slice(0, 1500)}`];
  if (o.attachments?.length) parts.push(`Attachments: ${o.attachments.slice(0, 8).map((n) => `${n} (${KIND(n)})`).join(', ')}`);
  if (o.agent) parts.push(`Handled by the agent: ${o.agent}`);
  if (o.answer?.trim()) parts.push(`The start of the answer:\n${o.answer.trim().slice(0, 800)}`);
  return parts.join('\n\n');
}

/** A model's reply → a clean one-line title, or null when it is unusable. */
export function cleanTitle(raw: string): string | null {
  let t = raw.replace(/\r/g, '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  t = t
    .replace(/^["'«“„‟‘‚「『【《〈`*#>\s-]+|["'»“”’」』】》〉`*\s]+$/gu, '')
    .replace(/^(title|название|заголовок|имя задачи)\s*\**\s*[:—-]\s*\**\s*/i, '')
    .replace(/[.。]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length < 3) return null;
  if (/^(i |i'm |sorry|as an ai|извин|к сожалению)/i.test(t)) return null; // a refusal, not a title
  if (t.length > MAX_TITLE) {
    const cut = t.slice(0, MAX_TITLE - 1);
    const sp = cut.lastIndexOf(' ');
    t = `${sp > 30 ? cut.slice(0, sp) : cut}…`;
  }
  return t;
}
