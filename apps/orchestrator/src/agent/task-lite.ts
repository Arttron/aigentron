import type { PrismaService } from '../prisma/prisma.service';

/**
 * The columns of a task that run-time code decides on (E-09). `TasksService.get()`
 * includes every session, approval, subtask and link — the worker and the
 * executor call it several times per job only to look at `status`/`parentId`.
 * This is the narrow read for those hot paths; the full `get()` stays for the
 * API. Lives here (not in tasks/) so it can be adopted without touching the
 * tasks service.
 */
export const TASK_LITE_SELECT = {
  id: true,
  status: true,
  parentId: true,
  agentName: true,
  worktreePath: true,
  branch: true,
  title: true,
  prompt: true,
  providerOverride: true,
} as const;

export type TaskLite = {
  id: string;
  status: string;
  parentId: string | null;
  agentName: string | null;
  worktreePath: string | null;
  branch: string | null;
  title: string;
  prompt: string;
  providerOverride: string | null;
};

export async function getTaskLite(prisma: PrismaService, id: string): Promise<TaskLite | null> {
  return prisma.task.findUnique({ where: { id }, select: TASK_LITE_SELECT }) as Promise<TaskLite | null>;
}

export async function getTaskLiteOrThrow(prisma: PrismaService, id: string): Promise<TaskLite> {
  const t = await getTaskLite(prisma, id);
  if (!t) throw new Error(`Task ${id} not found`);
  return t;
}
