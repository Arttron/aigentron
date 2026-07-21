import { IsDateString, IsOptional } from 'class-validator';

/** Query for GET /api/stats/usage — an optional [from, to] range (ISO 8601). */
export class UsageQueryDto {
  /** Inclusive lower bound on session start (ISO 8601). Omit for unbounded. */
  @IsOptional()
  @IsDateString()
  from?: string;

  /** Inclusive upper bound on session start (ISO 8601). Omit for unbounded. */
  @IsOptional()
  @IsDateString()
  to?: string;
}
