import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { PROJECT_ISOLATIONS, PROJECT_KINDS, PROJECT_REPO_AUTHS, SLUG_RE } from '../project-core';

/** Body of POST /api/projects. Field semantics: ProjectsService.validateFields (the real checks live there). */
export class CreateProjectDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  /** Folder name; derived from the name when omitted. Immutable afterwards. */
  @IsOptional()
  @IsString()
  @Matches(SLUG_RE, { message: 'slug must be 1–40 lowercase letters, digits or hyphens, starting with a letter or digit' })
  slug?: string;

  @IsOptional()
  @IsIn([...PROJECT_KINDS])
  kind?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  repoUrl?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  repoBranch?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  repoSubdir?: string | null;

  @IsOptional()
  @IsIn([...PROJECT_REPO_AUTHS])
  repoAuth?: string;

  /** Absolute checkout path to adopt in place (null = `<PROJECTS_DIR>/<slug>/repo`). */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  repoPath?: string | null;

  @IsOptional()
  @IsIn([...PROJECT_ISOLATIONS, null])
  isolation?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  verifyCommands?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10)
  verifyMaxAttempts?: number;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  defaultAgent?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  notifyChannelId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  notifyChatId?: string | null;
}

/** Body of PATCH /api/projects/:slug — any field of the create body except the slug. */
export class UpdateProjectDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsIn([...PROJECT_KINDS])
  kind?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  repoUrl?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  repoBranch?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  repoSubdir?: string | null;

  @IsOptional()
  @IsIn([...PROJECT_REPO_AUTHS])
  repoAuth?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  repoPath?: string | null;

  @IsOptional()
  @IsIn([...PROJECT_ISOLATIONS, null])
  isolation?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  verifyCommands?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10)
  verifyMaxAttempts?: number;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  defaultAgent?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  notifyChannelId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  notifyChatId?: string | null;

  /** `false` brings an archived project back (archiving itself is POST …/archive). */
  @IsOptional()
  @IsBoolean()
  archived?: boolean;
}
