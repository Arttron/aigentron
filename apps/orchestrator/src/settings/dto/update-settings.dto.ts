import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/** PUT /api/settings body. All fields optional; only present ones are changed. */
export class UpdateSettingsDto {
  @IsOptional()
  @IsInt()
  @Min(10)
  @Max(3600)
  approvalTimeoutSeconds?: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  verifyCommands?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10)
  verifyMaxAttempts?: number;

  @IsOptional()
  @IsBoolean()
  debugMode?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  agentInstructions?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  defaultProvider?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  defaultAgent?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  repoUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  repoBranch?: string;

  // Relative subdirectory within the workspace repo (e.g. `apps/web`). Absolute
  // paths / `..` traversal are normalized away server-side (→ repo root).
  @IsOptional()
  @IsString()
  @MaxLength(300)
  workspaceSubdir?: string;

  @IsOptional()
  @IsString()
  @MaxLength(400)
  githubToken?: string;

  // Default escalation destination for tasks with no channel of their own.
  @IsOptional()
  @IsString()
  @MaxLength(100)
  notifyChannelId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  notifyChatId?: string;
}
