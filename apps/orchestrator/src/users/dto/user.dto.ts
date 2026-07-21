import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { USER_ROLES, type ChannelKind, type UserRole } from '@lds/shared';

const CHANNELS = ['dashboard', 'slack', 'telegram', 'email'] as const;

export class ChannelIdentityDto {
  @IsIn(CHANNELS)
  channel!: ChannelKind;

  @IsString()
  @MaxLength(200)
  externalId!: string;
}

export class CreateUserDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  displayName!: string;

  @IsOptional()
  @IsIn(USER_ROLES as readonly string[])
  role?: UserRole;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ChannelIdentityDto)
  identities?: ChannelIdentityDto[];
}

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  displayName?: string;

  @IsOptional()
  @IsIn(USER_ROLES as readonly string[])
  role?: UserRole;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ChannelIdentityDto)
  identities?: ChannelIdentityDto[];
}
