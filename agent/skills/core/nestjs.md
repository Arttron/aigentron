---
name: nestjs
description: Conventions, code patterns, and standards for building NestJS backend modules — modules, services, controllers, DTOs, guards. Use when writing or reviewing any NestJS backend code.
---

# Skill: NestJS
**Applies to:** Architect, Backend, Coder, Reviewer

---

## Project structure

```
src/
├── modules/
│   └── [feature]/
│       ├── [feature].module.ts
│       ├── [feature].controller.ts
│       ├── [feature].service.ts
│       ├── dto/
│       │   ├── create-[feature].dto.ts
│       │   └── update-[feature].dto.ts
│       └── entities/
│           └── [feature].entity.ts
├── common/
│   ├── guards/
│   ├── decorators/
│   ├── filters/
│   └── interceptors/
└── config/
```

## Code standards

### Module
```typescript
@Module({
  imports: [TypeOrmModule.forFeature([Entity])],
  controllers: [FeatureController],
  providers: [FeatureService],
  exports: [FeatureService],
})
export class FeatureModule {}
```

### DTO with validation
```typescript
import { IsString, IsEmail, IsOptional, MinLength } from 'class-validator';

export class CreateUserDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8)
  password: string;

  @IsString()
  @IsOptional()
  name?: string;
}
```

### Service
```typescript
@Injectable()
export class FeatureService {
  constructor(
    @InjectRepository(Feature)
    private readonly featureRepo: Repository<Feature>,
  ) {}

  async findAll(): Promise<Feature[]> {
    return this.featureRepo.find();
  }

  async findOne(id: string): Promise<Feature> {
    const item = await this.featureRepo.findOne({ where: { id } });
    if (!item) throw new NotFoundException(`Feature ${id} not found`);
    return item;
  }

  async create(dto: CreateFeatureDto): Promise<Feature> {
    const item = this.featureRepo.create(dto);
    return this.featureRepo.save(item);
  }
}
```

### Controller
```typescript
@Controller('features')
@UseGuards(JwtAuthGuard)
export class FeatureController {
  constructor(private readonly featureService: FeatureService) {}

  @Get()
  findAll() {
    return this.featureService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.featureService.findOne(id);
  }

  @Post()
  create(@Body() dto: CreateFeatureDto) {
    return this.featureService.create(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateFeatureDto) {
    return this.featureService.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.featureService.remove(id);
  }
}
```

## Mandatory rules

- Always use DTOs with `class-validator`.
- Guards on every private endpoint.
- Use `NotFoundException`, `BadRequestException` from `@nestjs/common` — don't roll your own.
- Never return passwords in a response.
- Pagination (`page`, `limit`) on every list endpoint.
- Log via NestJS `Logger`, never `console.log`.

## PostgreSQL patterns

- TypeORM for data access.
- Repository pattern via `@InjectRepository`.
- Transactions for operations touching multiple tables.
- Indexes on frequently queried fields.
