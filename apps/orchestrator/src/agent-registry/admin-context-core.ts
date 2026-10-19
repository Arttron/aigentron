/** What the person is looking at when they talk to the admin (docs/…: the dashboard reports its route with each message). */
export interface PageRef {
  /** `/tasks/abc`, `/projects/web`, `/settings` — the dashboard route, without a query string. */
  path: string;
  /** The browser tab title, when the dashboard sends it. */
  title?: string;
}

export type PageKind = 'task' | 'project' | 'page';

export interface ParsedPage {
  kind: PageKind;
  /** task id / project slug for the first two kinds. */
  id?: string;
  /** A plain-language name of the page. */
  name: string;
}

const PAGES: Record<string, string> = {
  '': 'the task list (home page)',
  agents: 'the Agents page (agent definitions, providers per agent, fallbacks)',
  settings: 'the Settings page (providers, channels, MCP, security, escalations, updates…)',
  stats: 'the Usage stats page (tokens, requests and cost per provider)',
  resources: 'the Resources page (notes, photos, documents the agents can use)',
  knowledge: 'the Knowledge page (searchable knowledge bases)',
  workspace: 'the Workspace page (the shared folder: memory, work, deliverables)',
  projects: 'the Projects list',
  browser: 'the Browser add-on page',
};

/** Parse a dashboard route into what the admin can look up. Unknown routes are described by their path. */
export function parsePage(path: string): ParsedPage {
  const clean = (path.split(/[?#]/)[0] ?? '').replace(/^\/+|\/+$/g, '');
  const [first = '', second] = clean.split('/');
  if (first === 'tasks' && second) return { kind: 'task', id: decodeURIComponent(second), name: 'a task page' };
  if (first === 'projects' && second) return { kind: 'project', id: decodeURIComponent(second), name: 'a project page' };
  return { kind: 'page', name: PAGES[first] ?? `the page "/${clean}"` };
}

/** Accept only a plain dashboard path from the client (it is shown to the model as data). */
export function sanitizePage(input: unknown): PageRef | null {
  if (!input || typeof input !== 'object') return null;
  const { path, title } = input as Record<string, unknown>;
  if (typeof path !== 'string' || !path.startsWith('/') || path.length > 300) return null;
  return { path, title: typeof title === 'string' ? title.slice(0, 200) : undefined };
}
