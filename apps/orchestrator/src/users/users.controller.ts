import { Body, Controller, Delete, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import type { User, UserRole } from '@lds/shared';
import { UsersService, type UserRow, type UserPatch } from './users.service';
import { CreateUserDto, UpdateUserDto } from './dto/user.dto';
import { RolesGuard } from '../identity/roles.guard';
import { Roles } from '../identity/roles.decorator';

/** Wire shape for a user. */
function serialize(u: UserRow): User {
  return {
    id: u.id,
    displayName: u.displayName,
    role: u.role as UserRole,
    identities: u.identities.map((i) => ({
      id: i.id,
      channel: i.channel as User['identities'][number]['channel'],
      externalId: i.externalId,
    })),
    createdAt: u.createdAt.toISOString(),
  };
}

function toPatch(dto: UpdateUserDto): UserPatch {
  const patch: UserPatch = {};
  if (dto.displayName !== undefined) patch.displayName = dto.displayName;
  if (dto.role !== undefined) patch.role = dto.role;
  if (dto.identities !== undefined) patch.identities = dto.identities;
  return patch;
}

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  /** Open: the dashboard needs the roster to pick an acting user. */
  @Get()
  async list() {
    return (await this.users.list()).map(serialize);
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    return serialize(await this.users.getRow(id));
  }

  @Post()
  @UseGuards(RolesGuard)
  @Roles('operator', 'admin')
  async create(@Body() dto: CreateUserDto) {
    return serialize(
      await this.users.create({
        displayName: dto.displayName,
        role: dto.role,
        identities: dto.identities,
      }),
    );
  }

  @Put(':id')
  @UseGuards(RolesGuard)
  @Roles('operator', 'admin')
  async update(@Param('id') id: string, @Body() dto: UpdateUserDto) {
    return serialize(await this.users.update(id, toPatch(dto)));
  }

  @Delete(':id')
  @UseGuards(RolesGuard)
  @Roles('operator', 'admin')
  async remove(@Param('id') id: string) {
    await this.users.remove(id);
    return { id, deleted: true };
  }
}
