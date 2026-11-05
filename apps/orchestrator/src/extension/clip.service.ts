import { Readable } from 'node:stream';
import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { AttachmentsService } from '../attachments/attachments.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { ProjectsService } from '../projects/projects.service';
import { TasksService } from '../tasks/tasks.service';
import { noteText, parseClip, taskPrompt, taskTitle } from './clip-core';

/** "Send to Aigentron" from the browser extension: one call that does the whole job, so the extension's token needs no general task API. */
@Injectable()
export class ClipService {
  constructor(
    private readonly tasks: TasksService,
    private readonly attachments: AttachmentsService,
    private readonly knowledge: KnowledgeService,
    private readonly projects: ProjectsService,
  ) {}

  async clip(body: unknown, user: { id: string; role: string }): Promise<{ kind: 'task'; id: string; path: string } | { kind: 'followup'; id: string; path: string; title: string } | { kind: 'kb'; id: string; kb: string }> {
    const parsed = parseClip(body);
    if (!parsed.ok) throw new BadRequestException(parsed.error);
    const c = parsed.value;
    // creating a task: the roles of POST /tasks; a note for a knowledge base: the roles of that endpoint
    if (c.mode === 'task' && !['task_setter', 'operator', 'admin'].includes(user.role)) throw new ForbiddenException('Your role cannot create tasks.');
    if (c.mode === 'followup' && !['task_setter', 'operator', 'admin'].includes(user.role)) throw new ForbiddenException('Your role cannot write to tasks.');
    if (c.mode === 'kb' && !['operator', 'admin'].includes(user.role)) throw new ForbiddenException('Your role cannot add to a knowledge base.');
    // A message in a task that exists: the same thing the dashboard's follow-up box does (the picture is saved among the task's files first, then the message names it).
    if (c.mode === 'followup') {
      const task = await this.tasks.getLite(c.taskId!); // 404 for an unknown task
      const names: string[] = [];
      if (c.screenshot) {
        const data = Buffer.from(c.screenshot, 'base64');
        const meta = await this.attachments.save(task.id, 'page-screenshot.jpg', Readable.from(data), data.length);
        names.push(meta.name);
      }
      await this.tasks.followUp(task.id, taskPrompt(c), names.length ? names : undefined);
      return { kind: 'followup', id: task.id, path: `/tasks/${task.id}`, title: task.title ?? '' };
    }
    const project = await this.projects.forNewTask(c.project); // 404 for an unknown slug, 400 for an archived one

    if (c.mode === 'kb') {
      // the project's own bases and the global ones (every project may use those)
      const bases = [...((await this.knowledge.list(project.slug)) as { name: string }[]), ...((await this.knowledge.list('global')) as { name: string }[])];
      if (!bases.some((b) => b.name === c.kb)) throw new BadRequestException(`"${c.kb}" is not a knowledge base of project "${project.slug}" (nor a global one)`);
      const r = await this.knowledge.addNote(c.kb!, noteText(c));
      return { kind: 'kb', id: (r as { id?: string; docId?: string }).id ?? (r as { docId?: string }).docId ?? '', kb: c.kb! };
    }

    // a task with a screenshot is created deferred, so the run never reads the attachments folder before the picture lands (like the dashboard's form)
    const task = await this.tasks.create(
      { prompt: taskPrompt(c), title: taskTitle(c), agentName: c.agentName, project: project.slug, autostart: !c.screenshot } as never,
      user.id,
    );
    if (c.screenshot) {
      try {
        const data = Buffer.from(c.screenshot, 'base64');
        const meta = await this.attachments.save(task.id, 'page-screenshot.jpg', Readable.from(data), data.length);
        await this.tasks.start(task.id, [meta.name]);
      } catch (e) {
        await this.tasks.delete(task.id).catch(() => undefined); // nothing ran yet: do not leave a task without its picture behind
        throw e;
      }
    }
    return { kind: 'task', id: task.id, path: `/tasks/${task.id}` };
  }
}
