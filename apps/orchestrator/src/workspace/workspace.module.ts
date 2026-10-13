import { Global, Module } from '@nestjs/common';
import { WorkspaceController } from './workspace.controller';
import { WorkspaceService } from './workspace.service';

/** Global: the agent executor, the maintenance report and the dashboard read the same workspace. */
@Global()
@Module({ controllers: [WorkspaceController], providers: [WorkspaceService], exports: [WorkspaceService] })
export class WorkspaceModule {}
