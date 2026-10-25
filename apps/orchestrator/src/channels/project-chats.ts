/**
 * Which chats an unthreaded task (a dashboard task) may be announced in — an approval or a question nobody answered in the dashboard. Pure.
 *
 * A project can own a chat (its notification channel + chat). Then: a task of that project is announced in ITS chat(s) only, and a chat owned by a project
 * hears about no other project's tasks. A project without a chat is announced in every allowed chat that no other project owns.
 */
export interface ChatRef {
  channelId: string;
  chatId: string;
}
export interface ChatBinding extends ChatRef {
  projectId: string;
}

const key = (c: ChatRef): string => `${c.channelId}\u0000${c.chatId}`;

export function chatTargets(projectId: string, allowed: readonly ChatRef[], bindings: readonly ChatBinding[]): ChatRef[] {
  const own = bindings.filter((b) => b.projectId === projectId);
  if (own.length) {
    const wanted = new Set(own.map(key));
    // only chats the channel actually lets us talk to
    return allowed.filter((c) => wanted.has(key(c)));
  }
  const owned = new Set(bindings.map(key));
  return allowed.filter((c) => !owned.has(key(c)));
}
