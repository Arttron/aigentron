import { Type } from 'class-transformer';
import { IsDateString, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

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

  /** Limit the provider rows to one project (its slug). The per-project breakdown always lists every project. */
  @IsOptional()
  @IsString()
  @MaxLength(80)
  project?: string;

  /** The viewer's offset behind UTC in minutes (`new Date().getTimezoneOffset()`): the days of the per-day view are theirs. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(-840)
  @Max(840)
  tz?: number;
}
