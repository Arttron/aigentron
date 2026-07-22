import { IsIn, IsInt, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator';

const KINDS = ['anthropic', 'openai', 'deepseek', 'ollama'] as const;
// oauth-token: a CLI-minted subscription token (e.g. `claude setup-token`) —
// bypasses LiteLLM, see @lds/shared resolveProvider().
const AUTH_MODES = ['api-key', 'auth-token', 'oauth-token'] as const;

export class CreateProviderDto {
  @IsString()
  @Matches(/^[\w-]+$/, { message: 'name must be alphanumeric/dash/underscore' })
  @MaxLength(60)
  name!: string;

  // Upstream family → LiteLLM backend. Defaults from baseUrl if omitted.
  @IsOptional()
  @IsIn(KINDS)
  kind?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  baseUrl?: string;

  // Optional default model — agents may pick their own per-agent model instead.
  @IsOptional()
  @IsString()
  @MaxLength(200)
  model?: string;

  @IsOptional()
  @IsIn(AUTH_MODES)
  authMode?: (typeof AUTH_MODES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(400)
  secret?: string;

  /** Optional per-provider rate caps (LiteLLM-enforced) for rate-limited upstreams. */
  @IsOptional()
  @IsInt()
  @Min(0)
  rpm?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  tpm?: number;
}

/** Ad-hoc params to preview a provider's model list before saving. */
export class ModelsPreviewDto {
  @IsOptional()
  @IsIn(KINDS)
  kind?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  baseUrl?: string;

  @IsOptional()
  @IsIn(AUTH_MODES)
  authMode?: (typeof AUTH_MODES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(400)
  secret?: string;
}

export class UpdateProviderDto {
  @IsOptional()
  @IsIn(KINDS)
  kind?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  baseUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  model?: string;

  @IsOptional()
  @IsIn(AUTH_MODES)
  authMode?: (typeof AUTH_MODES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(400)
  secret?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  rpm?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  tpm?: number;
}
