/**
 * Canonical list of channel commands — the single source for both the /help
 * text and the messenger's native command menu (e.g. Telegram setMyCommands).
 * `command` is the bare name (no slash, lowercase, [a-z0-9_]) per Telegram rules.
 */
export interface CommandDef {
  command: string;
  description: string;
  /** Shown in /help; defaults to `/<command>`. */
  usage?: string;
}

export const COMMAND_MENU: CommandDef[] = [
  { command: 'new_task', description: 'Start a new task', usage: '/new_task <text>' },
  { command: 'tasks', description: 'List recent tasks' },
  { command: 'task', description: 'Switch to a task', usage: '/task <id>' },
  { command: 'status', description: 'Active task status' },
  { command: 'subtasks', description: 'Subtasks of the active task' },
  { command: 'cancel', description: 'Stop the active task' },
  { command: 'clear', description: 'Forget the active task' },
  { command: 'approve', description: 'Approve a pending request' },
  { command: 'deny', description: 'Deny a pending request' },
  { command: 'compress', description: 'Summarize the active task' },
  { command: 'pr', description: 'Pull request link' },
  { command: 'web', description: 'Open in the dashboard' },
  { command: 'agents', description: 'List agents' },
  { command: 'agent', description: 'Set the agent for new tasks', usage: '/agent <name>' },
  { command: 'models', description: 'List models' },
  { command: 'model', description: 'Set the model for new tasks', usage: '/model <name>' },
  { command: 'settings', description: 'Show what is selected' },
  { command: 'mute', description: 'Mute routine updates' },
  { command: 'unmute', description: 'Resume updates' },
  { command: 'help', description: 'Show commands' },
];

/** Readable /help body built from the menu. */
export const HELP_TEXT = [
  'Commands:',
  ...COMMAND_MENU.map((c) => `${c.usage ?? `/${c.command}`} — ${c.description}`),
  '',
  'A plain message continues the active task. Send a photo/file to attach it.',
].join('\n');
