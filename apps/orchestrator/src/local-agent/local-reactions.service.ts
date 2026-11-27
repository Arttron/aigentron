import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ChannelManagerService } from '../channels/channel-manager.service';
import { ProjectsService } from '../projects/projects.service';
import { TasksService } from '../tasks/tasks.service';
import { LocalBindingsService } from './local-bindings.service';
import { LocalBridgeService } from './local-bridge.service';
import { LocalDevicesService } from './local-devices.service';
import { noticeText, parseNotice, parseProposal, proposalPrompt } from './local-events';

const NOTICE_GAP_MS = 60 * 60 * 1000; // the same notice to the same project at most once an hour
const PROPOSAL_GAP_MS = 6 * 60 * 60 * 1000; // a commit proposal for the same repository at most every 6 hours

/**
 * What the server does with the events the rules engine of a local agent sends: a `notice` becomes a message in the project's notification chat; a
 * `propose-commit` becomes a task that asks an agent to suggest a commit. Both go only to projects the person bound to that repository (the binding is
 * the consent), and only a read-capable task is created: nothing here changes the person's repository.
 *
 * A separate module from the line itself: tasks and channels depend on the agent module, which depends on the local-agent module.
 */
@Injectable()
export class LocalReactionsService implements OnModuleInit {
  private readonly logger = new Logger(LocalReactionsService.name);
  private readonly last = new Map<string, number>();

  constructor(
    private readonly bridge: LocalBridgeService,
    private readonly bindings: LocalBindingsService,
    private readonly devices: LocalDevicesService,
    private readonly projects: ProjectsService,
    private readonly channels: ChannelManagerService,
    private readonly tasks: TasksService,
  ) {}

  onModuleInit(): void {
    this.bridge.onEvent((deviceId, name, data) => {
      const run =
        name === 'notice'
          ? this.onNotice(deviceId, data)
          : name === 'propose-commit'
            ? this.onProposal(deviceId, data)
            : null;
      run?.catch((e) => this.logger.warn(`${name} from ${deviceId}: ${(e as Error).message}`));
    });
  }

  /** Rate limit by key; true = go ahead (and the time is taken). */
  private allow(key: string, gapMs: number, now = Date.now()): boolean {
    const at = this.last.get(key);
    if (at !== undefined && now - at < gapMs) return false;
    if (this.last.size > 500) this.last.clear();
    this.last.set(key, now);
    return true;
  }

  private computer(deviceId: string): string {
    return this.devices.list().find((d) => d.id === deviceId)?.label ?? 'a connected computer';
  }

  private projectsOf(deviceId: string, repoId: string): string[] {
    return [
      ...new Set(
        this.bindings
          .list()
          .filter((b) => b.deviceId === deviceId && b.repoId === repoId)
          .map((b) => b.projectId),
      ),
    ];
  }

  async onNotice(deviceId: string, data: unknown): Promise<void> {
    const n = parseNotice(data);
    if (!n) return;
    for (const projectId of this.projectsOf(deviceId, n.repo)) {
      if (!this.allow(`notice:${deviceId}:${n.repo}:${projectId}:${n.kind}`, NOTICE_GAP_MS))
        continue;
      const project = await this.projects.getById(projectId).catch(() => null);
      if (!project || project.archivedAt) continue;
      await this.channels.notifyProject(
        projectId,
        noticeText(n, { project: project.name, computer: this.computer(deviceId) }),
      );
    }
  }

  async onProposal(deviceId: string, data: unknown): Promise<void> {
    const p = parseProposal(data);
    if (!p) return;
    for (const projectId of this.projectsOf(deviceId, p.repo)) {
      if (!this.allow(`propose:${deviceId}:${p.repo}:${projectId}`, PROPOSAL_GAP_MS)) continue;
      const project = await this.projects.getById(projectId).catch(() => null);
      if (!project || project.archivedAt) continue;
      const computer = this.computer(deviceId);
      await this.tasks.create({
        prompt: proposalPrompt(p, { computer }),
        title: `Suggest a commit — ${project.name}`,
        project: project.slug,
      });
      this.logger.log(
        `Opened a commit-suggestion task for project "${project.slug}" (${computer})`,
      );
    }
  }
}
