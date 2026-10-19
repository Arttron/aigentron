import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { PROJECT_REPO_AUTHS } from '../project-core';

/** Body of PUT /api/projects/:slug/repo — the real checks are ProjectsService.validateFields. */
export class UpdateRepoDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  url?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  branch?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  subdir?: string | null;
}

/** Body of PUT /api/projects/:slug/repo/credentials. The secret arrives here once and is never returned. */
export class RepoCredentialsDto {
  @IsIn([...PROJECT_REPO_AUTHS])
  auth!: 'none' | 'token' | 'ssh';

  /** auth=token */
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  token?: string;

  /** auth=ssh: generate a fresh ed25519 key (default when no privateKey is given) or import the given one */
  @IsOptional()
  @IsIn(['generate', 'import'])
  action?: 'generate' | 'import';

  /** auth=ssh, action=import: the unencrypted private key (OpenSSH or PEM format) */
  @IsOptional()
  @IsString()
  @MaxLength(40_000)
  privateKey?: string;
}

/** Body of POST /api/projects/:slug/repo/test */
export class RepoTestDto {
  /** also try a `git push --dry-run` of a throwaway ref (contacts the remote, changes nothing) */
  @IsOptional()
  @IsBoolean()
  checkWrite?: boolean;
}
