import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/** Query params for the paginated + searchable task list. */
export class ListTasksDto {
  /** Free-text search over title/prompt (and exact id match). Empty = no filter. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  /** 1-based page number. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  /** Page size (top-level tasks per page). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}
