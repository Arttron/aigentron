import { BadGatewayException, BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, Post, Put, UseGuards } from '@nestjs/common';
import { RolesGuard } from '../../identity/roles.guard';
import { Roles } from '../../identity/roles.decorator';
import { GitAccessError, GitAccessService } from './git-access.service';
import { GitRunError } from './git-runner';
import { RepoSyncService } from './repo-sync.service';
import { RepoCredentialsDto, RepoTestDto, UpdateRepoDto } from './repo.dto';

/**
 * A project's repository: settings, access (token / SSH key), the connection test, sync (docs/projects.md).
 * Reading the status is open to every signed-in role; everything that changes or contacts the remote is for
 * operators and admins. No response ever carries a token or a private key.
 */
@Controller('projects/:slug/repo')
export class ProjectRepoController {
  constructor(
    private readonly access: GitAccessService,
    private readonly sync: RepoSyncService,
  ) {}

  @Get()
  status(@Param('slug') slug: string) {
    return this.access.status(slug);
  }

  @Put()
  @UseGuards(RolesGuard)
  @Roles('operator', 'admin')
  update(@Param('slug') slug: string, @Body() dto: UpdateRepoDto) {
    return this.access.setRepo(slug, dto);
  }

  @Put('credentials')
  @UseGuards(RolesGuard)
  @Roles('operator', 'admin')
  async credentials(@Param('slug') slug: string, @Body() dto: RepoCredentialsDto) {
    return this.access.setCredentials(slug, dto).catch(rethrow);
  }

  /** Forget the pinned host key (after a legitimate host key change). */
  @Delete('host-key')
  @UseGuards(RolesGuard)
  @Roles('operator', 'admin')
  resetHostKey(@Param('slug') slug: string) {
    return this.access.resetHostKey(slug);
  }

  @Post('test')
  @HttpCode(200)
  @UseGuards(RolesGuard)
  @Roles('operator', 'admin')
  test(@Param('slug') slug: string, @Body() dto: RepoTestDto) {
    return this.access.test(slug, { checkWrite: Boolean(dto?.checkWrite) });
  }

  /** Clone (first time) or fetch the project's checkout now. */
  @Post('sync')
  @HttpCode(200)
  @UseGuards(RolesGuard)
  @Roles('operator', 'admin')
  async syncNow(@Param('slug') slug: string) {
    return this.sync.ensure(slug).catch(rethrow);
  }
}

function rethrow(e: unknown): never {
  if (e instanceof GitAccessError) throw new BadRequestException(e.message);
  if (e instanceof GitRunError) throw new BadGatewayException(e.message);
  throw e;
}
