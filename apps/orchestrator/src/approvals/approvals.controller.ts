import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import type { ApprovalStatus, HookCheckResponse } from '@lds/shared';
import { ApprovalsService } from './approvals.service';
import { HookCheckDto } from './dto/hook-check.dto';
import { ApprovalDecisionDto } from './dto/approval-decision.dto';
import { HookSecretGuard } from './hook-secret.guard';
import { RolesGuard } from '../identity/roles.guard';
import { Roles } from '../identity/roles.decorator';
import { CurrentUser } from '../identity/current-user.decorator';
import type { UserRow } from '../users/users.service';

/** Bounds for the hook's long-poll window (1s … 1h). */
const WAIT_MIN_MS = 1_000;
const WAIT_MAX_MS = 60 * 60 * 1_000;

@Controller('approvals')
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  /** Hook entrypoint: classify a tool call, returning allow or an approvalId. */
  @Post('check')
  @UseGuards(HookSecretGuard)
  check(@Body() dto: HookCheckDto): Promise<HookCheckResponse> {
    return this.approvals.check(dto);
  }

  /** Hook long-poll: block until the verdict lands (or fail-closed timeout). */
  @Get(':id/wait')
  @UseGuards(HookSecretGuard)
  wait(@Param('id') id: string, @Query('timeoutMs') timeoutMs?: string) {
    const raw = timeoutMs ? Number.parseInt(timeoutMs, 10) : NaN;
    // Clamp the client-supplied window so a bad/hostile value can't pin a
    // server-side timer (and the held connection) open indefinitely.
    const ms = Number.isFinite(raw)
      ? Math.min(Math.max(raw, WAIT_MIN_MS), WAIT_MAX_MS)
      : undefined;
    return this.approvals.waitForVerdict(id, ms);
  }

  /** Dashboard: list approvals, optionally filtered by status. */
  @Get()
  list(@Query('status') status?: ApprovalStatus) {
    return this.approvals.list(status);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.approvals.get(id);
  }

  /** Human verdict for a pending approval. */
  @Post(':id/decision')
  @UseGuards(RolesGuard)
  @Roles('reviewer', 'operator', 'admin')
  decide(
    @Param('id') id: string,
    @Body() dto: ApprovalDecisionDto,
    @CurrentUser() user: UserRow,
  ) {
    return this.approvals.decide(
      id,
      dto.decision,
      { id: user.id, displayName: user.displayName },
      { taskException: dto.taskException, globalException: dto.globalException },
    );
  }
}
