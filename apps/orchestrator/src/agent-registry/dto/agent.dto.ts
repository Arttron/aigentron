import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class AgentBodyDto {
  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  provider?: string;

  /** Comma-separated provider names to fail over to if the primary errors. */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  fallbackProviders?: string;

  /** Model to run on; blank uses the provider's default model. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  model?: string;

  /** Comma-separated skill filenames (subset of ./agent/skills). */
  @IsOptional()
  @IsString()
  @MaxLength(400)
  skills?: string;

  /** Comma-separated tool allow/deny lists (e.g. read-only reviewer). */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  allowedTools?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  disallowedTools?: string;

  /** Comma-separated MCP server names (from the MCP registry). */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  mcp?: string;

  @IsString()
  @MaxLength(20000)
  instructions!: string;
}

export class CreateAgentDto extends AgentBodyDto {
  @IsString()
  @Matches(/^[\w-]+$/, { message: 'name must be alphanumeric/dash/underscore' })
  @MaxLength(60)
  name!: string;
}
