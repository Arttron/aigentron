import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateTaskDto {
  @IsString()
  @MinLength(1)
  @MaxLength(20000)
  prompt!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  /** Optional named agent (see ./agent/agents/<name>.md). */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  agentName?: string;

  /** Filenames already uploaded to this task, bound to the first message. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  attachments?: string[];

  /** When false, the task is created but not queued — the client uploads
   *  attachments first, then calls /start. Defaults to true. */
  @IsOptional()
  @IsBoolean()
  autostart?: boolean;

  /** Parent task id when creating a subtask (decomposition). */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  parentId?: string;

  /** External origin, e.g. "telegram:<chatId>" (set by channel adapters, not the UI). */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  createdByChannel?: string;

  /** Provider (model endpoint) to run on, overriding the agent/default. */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  provider?: string;

  /** Ids of related tasks whose summaries fold into this task's context. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  references?: string[];
}
