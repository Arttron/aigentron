import { Global, Module } from '@nestjs/common';
import { GIT_CREDENTIALS } from '../git-credentials.port';
import { ProjectsModule } from '../projects.module';
import { GitAccessService } from './git-access.service';
import { ProjectRepoController } from './project-repo.controller';
import { RepoSyncService } from './repo-sync.service';

/**
 * Repository access per project (docs/projects.md). Global: every module that injects `GIT_CREDENTIALS` gets
 * GitAccessService (files in the secrets dir), and `RepoSyncService` clones/fetches a project's checkout.
 *
 * Precedence: a module's OWN providers shadow a global export in Nest, so the runtime module must NOT declare its
 * own `GIT_CREDENTIALS` provider (the interim `LegacyTokenCredentials`) once this module is in app.module.ts —
 * GitAccessService already covers the legacy case (the default project's AppSettings.githubToken is used as a
 * fallback and migrated to its file at boot). Nothing imports this module explicitly; it is wired in AppModule.
 */
@Global()
@Module({
  imports: [ProjectsModule],
  controllers: [ProjectRepoController],
  providers: [GitAccessService, RepoSyncService, { provide: GIT_CREDENTIALS, useExisting: GitAccessService }],
  exports: [GIT_CREDENTIALS, GitAccessService, RepoSyncService],
})
export class GitAccessModule {}
