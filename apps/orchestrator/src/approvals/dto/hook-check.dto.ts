import { ArrayMaxSize, IsArray, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import type { HookCheckInput } from '@lds/shared';

/** Body the PreToolUse hook POSTs to `POST /api/approvals/check`. */
export class HookCheckDto implements HookCheckInput {
  @IsString()
  taskId!: string;

  @IsOptional()
  @IsString()
  agentSessionId?: string;

  @IsString()
  @MaxLength(200)
  toolName!: string;

  @IsObject()
  toolInput!: Record<string, unknown>;

  @IsOptional()
  @IsString()
  workspaceRoot?: string;

  @IsOptional()
  @IsString({ each: true })
  extraWriteRoots?: string[];

  /** Shared project knowledge written only through its tools (see ClassifyOptions.protectedPaths). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  protectedPaths?: string[];

  /** How strong the model of this run is (`cheap` | `mid` | `top`); a small model asks more (see approvalWaived). */
  @IsOptional()
  @IsString()
  @MaxLength(8)
  modelTier?: string;

  /** `$LDS_ATTACHMENTS_DIR` / `$TMPDIR` of the agent's shell (only those two are read). */
  @IsOptional()
  @IsObject()
  knownVars?: Record<string, string>;
}
