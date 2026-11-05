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

  /** Only tasks of this project (slug). */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  project?: string;

  /** `active` (default): tasks being worked on first, then the rest, each newest first; `created`: newest first, whatever their state. */
  @IsOptional()
  @IsString()
  @MaxLength(10)
  sort?: string;

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
