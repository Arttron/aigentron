import { ArrayMaxSize, IsArray, IsOptional, IsString, MaxLength } from 'class-validator';

export class FollowUpDto {
  /** Message text — may be empty when sending attachments only. */
  @IsOptional()
  @IsString()
  @MaxLength(20000)
  prompt?: string;

  /** Filenames already uploaded to this task, bound to this message. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  attachments?: string[];

  /** Ids of related tasks to reference from this message (folded into context). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  references?: string[];
}
