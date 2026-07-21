import { IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
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
}
