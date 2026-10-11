import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/** Query params for the paginated + searchable task list. */
export class ListTasksDto {
  /** Free-text search over title/prompt (and exact id match). Empty = no filter. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  /** Only tasks in this status (a status, or `active` / `attention`). */
  @IsOptional()
  @IsString()
  @MaxLength(20)
  status?: string;

  /** Only this type of task (task | subtask | chat | scheduled | channel | discussion). */
  @IsOptional()
  @IsString()
  @MaxLength(20)
  type?: string;

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
