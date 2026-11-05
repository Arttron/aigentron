// Pure helpers of the "send to Aigentron" page (no chrome.* here — unit-tested).

/** The key a project choice is remembered under: the host of the page (`github.com`). */
export function siteKey(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '') || '';
  } catch {
    return '';
  }
}

/** The project to preselect: remembered for this site → the last one used → the first (the default project is listed first by the server). */
export function pickProject(projects, memory, url) {
  const live = projects.filter((p) => !p.archivedAt);
  const has = (slug) => live.some((p) => p.slug === slug);
  const bySite = memory?.site?.[siteKey(url)];
  if (bySite && has(bySite)) return bySite;
  if (memory?.last && has(memory.last)) return memory.last;
  return live.find((p) => p.isDefault)?.slug ?? live[0]?.slug ?? '';
}

/** The agents the New-task list of a project offers: its pinned ones when it has any, else all; and the one to preselect. */
export function agentsFor(project, agents) {
  const pinned = Array.isArray(project?.pinnedAgents) && project.pinnedAgents.length ? new Set(project.pinnedAgents) : null;
  const list = agents.filter((a) => a.name.toLowerCase() !== 'admin' && (!pinned || pinned.has(a.name)));
  const def = project?.defaultAgent && list.some((a) => a.name === project.defaultAgent) ? project.defaultAgent : '';
  return { list, preselect: def };
}

/** Fit (w, h) into a box of `max` on the longest side, never enlarging. */
export function fitSize(w, h, max) {
  const k = Math.min(1, max / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)), k };
}

/** A rectangle dragged from (x1,y1) to (x2,y2) in any direction → {x,y,w,h} with positive size; null when it is just a click. */
export function normRect(x1, y1, x2, y2, min = 4) {
  const x = Math.min(x1, x2);
  const y = Math.min(y1, y2);
  const w = Math.abs(x2 - x1);
  const h = Math.abs(y2 - y1);
  return w >= min && h >= min ? { x, y, w, h } : null;
}

/** The body of POST /api/extension/clip from the state of the page. */
export function buildClip(s) {
  const toTask = s.mode === 'task' || s.mode === 'followup';
  return {
    mode: s.mode,
    // a message in an existing task needs the task, not a project (the task has its own)
    ...(s.mode === 'followup' ? { taskId: s.taskId } : { project: s.project }),
    ...(s.mode === 'task' && s.agentName ? { agentName: s.agentName } : {}),
    ...(s.mode === 'kb' ? { kb: s.kb } : {}),
    prompt: s.prompt.trim(),
    page: {
      url: s.draft.url,
      title: s.draft.title || '',
      ...(s.includeText && s.draft.text ? { text: s.draft.text } : {}),
      ...(s.includeSelection && s.draft.selection ? { selection: s.draft.selection } : {}),
    },
    ...(toTask && s.screenshot ? { screenshot: s.screenshot } : {}),
    ...(toTask && s.includeBug && s.draft.bug ? { bug: s.draft.bug } : {}),
  };
}

/** The tasks to offer in "a message in an existing task": newest first; a filter matches the title, the project and the status. */
export function filterTasks(tasks, query) {
  const q = String(query ?? '').trim().toLowerCase();
  const sorted = [...tasks].sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
  if (!q) return sorted;
  return sorted.filter((t) => [t.title, t.projectSlug ?? t.project?.slug ?? '', t.status, t.agentName ?? ''].join(' ').toLowerCase().includes(q));
}

const STATUS = { running: ['running', 'blue'], queued: ['queued', 'blue'], needs_approval: ['needs you', 'amber'], review: ['ready', 'green'], blocked: ['blocked', 'amber'], stalled: ['stalled', 'amber'], failed: ['failed', 'red'], done: ['done', 'green'], cancelled: ['cancelled', 'grey'] };
/** [label, tone] of a task's status for the list. */
export function statusLabel(status) {
  return STATUS[status] ?? [String(status ?? ''), 'grey'];
}
