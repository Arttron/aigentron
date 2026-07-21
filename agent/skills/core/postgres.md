---
name: postgres
description: TypeORM entity patterns, migration commands, query optimization, pagination, and transaction patterns for PostgreSQL. Use when working with database entities, migrations, or queries.
---

# Skill: PostgreSQL
**Applies to:** Architect, Backend, Coder, Reviewer

---

## Configuration (NestJS + TypeORM)

```typescript
// app.module.ts
TypeOrmModule.forRoot({
  type: 'postgres',
  url: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  entities: [__dirname + '/**/*.entity{.ts,.js}'],
  synchronize: false, // NEVER true in production
  migrations: [__dirname + '/migrations/*{.ts,.js}'],
  migrationsRun: true,
})
```

## Entity standards

```typescript
// base.entity.ts — extend every entity from this
import { CreateDateColumn, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export abstract class BaseEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
```

```typescript
// user.entity.ts
@Entity('users')
@Index(['email'])
export class User extends BaseEntity {
  @Column({ unique: true })
  email: string;

  @Column({ select: false }) // never returned by default
  password: string;

  @Column({ nullable: true })
  name: string;

  @OneToMany(() => Post, (post) => post.author)
  posts: Post[];
}
```

## Migrations

```bash
npm run migration:generate -- src/migrations/AddUserNameColumn
npm run migration:run
npm run migration:revert
```

```typescript
// package.json scripts
"migration:generate": "typeorm-ts-node-commonjs migration:generate -d src/config/datasource.ts",
"migration:run": "typeorm-ts-node-commonjs migration:run -d src/config/datasource.ts",
"migration:revert": "typeorm-ts-node-commonjs migration:revert -d src/config/datasource.ts"
```

## Query rules

### Avoid N+1
```typescript
// ❌ BAD — N+1 query
const users = await userRepo.find();
for (const user of users) {
  user.posts = await postRepo.findBy({ userId: user.id });
}

// ✅ GOOD — single query with join
const users = await userRepo.find({
  relations: { posts: true },
});
```

### Pagination
```typescript
async findAll(page = 1, limit = 20) {
  const [items, total] = await this.repo.findAndCount({
    skip: (page - 1) * limit,
    take: limit,
    order: { createdAt: 'DESC' },
  });

  return {
    items,
    meta: { page, limit, total, pages: Math.ceil(total / limit) },
  };
}
```

### Transactions
```typescript
async transferFunds(fromId: string, toId: string, amount: number) {
  return this.dataSource.transaction(async (manager) => {
    await manager.decrement(Account, { id: fromId }, 'balance', amount);
    await manager.increment(Account, { id: toId }, 'balance', amount);
  });
}
```

## Production notes

- Always use `DATABASE_URL` from env.
- SSL required in production.
- Respect the connection pool limit of the deployment tier.
- Back up before destructive migrations.
