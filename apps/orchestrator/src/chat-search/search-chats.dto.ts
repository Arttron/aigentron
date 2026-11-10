import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/** Query params of the search in chats. */
export class SearchChatsDto {
  /** The words to find: plain words are AND-ed, "quotes" make a phrase, -word leaves one out. */
  @IsString()
  @MaxLength(300)
  q!: string;

  /** all (default) | mine (messages people wrote, in tasks I created) | agents | results */
  @IsOptional()
  @IsString()
  @MaxLength(10)
  scope?: string;

  /** Project slug. */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  project?: string;

  /** Agent name. */
  @IsOptional()
  @IsString()
  @MaxLength(80)
  agent?: string;

  /** A task status, or `active` / `attention`. */
  @IsOptional()
  @IsString()
  @MaxLength(20)
  status?: string;

  /** ISO dates: messages from / to. */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  from?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  to?: string;

  /** `words` (default) | `pattern`: `q` is a regular expression, run over the latest messages. */
  @IsOptional()
  @IsString()
  @MaxLength(8)
  mode?: string;

  /** `best` (default) | `new` (newest task first). */
  @IsOptional()
  @IsString()
  @MaxLength(8)
  sort?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  pageSize?: number;
}
