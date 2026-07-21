import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import type { ApprovalDecisionInput } from '@lds/shared';

/** Body a human posts to `POST /api/approvals/:id/decision`. */
export class ApprovalDecisionDto implements ApprovalDecisionInput {
  @IsIn(['approve', 'deny'])
  decision!: 'approve' | 'deny';

  @IsOptional()
  @IsString()
  @MaxLength(200)
  decidedBy?: string;

  /** On approve: allowlist this exact call for the rest of this task. */
  @IsOptional()
  @IsBoolean()
  taskException?: boolean;

  /** On approve: allowlist this call globally (all tasks). */
  @IsOptional()
  @IsBoolean()
  globalException?: boolean;
}
