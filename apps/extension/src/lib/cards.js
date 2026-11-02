// Pure helpers of the approval / question cards (no chrome.* here — unit-tested).

const clip = (s, n) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n - 1)}…` : (s ?? ''));

/**
 * What a card shows. `task` = { title, project } when known. An approval the dashboard alone may decide carries `needsDashboard`.
 * Questions carry their options; the free-text field is offered when the agent allows it (or when there are no options).
 */
export function buildCard(item, task) {
  const where = [task?.project, task?.title].filter(Boolean).join(' · ');
  if (item.kind === 'question') {
    const q = item.data;
    return {
      kind: 'question',
      id: q.id,
      taskId: q.taskId,
      where,
      title: 'An agent asks you',
      text: clip(q.question, 600),
      options: Array.isArray(q.options) ? q.options.map((o) => clip(String(o), 120)) : [],
      multiple: Boolean(q.multiple),
      allowText: Boolean(q.allowText) || !q.options?.length,
    };
  }
  const a = item.data;
  return {
    kind: 'approval',
    id: a.id,
    taskId: a.taskId,
    where,
    title: 'An agent needs your approval',
    tool: clip(String(a.toolName ?? '').replace(/^mcp__lds_internal__/, ''), 80),
    summary: clip(a.summary, 800),
    reason: clip(a.reason, 300),
    needsDashboard: Boolean(a.needsDashboard),
  };
}

/** The oldest first (the one the agent waits on longest), approvals and questions together. */
export function orderItems(approvals, questions) {
  return [...approvals.map((data) => ({ kind: 'approval', data })), ...questions.map((data) => ({ kind: 'question', data }))].sort((x, y) => String(x.data.createdAt).localeCompare(String(y.data.createdAt)));
}

/** The text of a notification (the fallback where a card cannot be drawn). */
export function notificationText(card) {
  return card.kind === 'question'
    ? { title: card.title, message: [card.where, card.text].filter(Boolean).join('\n') }
    : { title: card.title, message: [card.where, card.summary || card.tool].filter(Boolean).join('\n') };
}

/** Pages a card can be drawn on (a content script cannot run on browser pages, the Web Store, …). */
export const injectable = (url) => /^https?:\/\//i.test(url ?? '') && !/^https?:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/i.test(url);

/**
 * The extension plays its sound only when no dashboard tab of this server is open: an open dashboard plays its own alert sound for the same request,
 * and two sounds for one request is noise. (The card on the page and the badge still show.)
 */
export const shouldPlaySound = (prefs, dashboardTabs) => Boolean(prefs?.sound) && dashboardTabs === 0;
