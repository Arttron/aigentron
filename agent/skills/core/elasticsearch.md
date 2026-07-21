---
name: elasticsearch
description: NestJS Elasticsearch service patterns, PostgreSQL-to-Elasticsearch sync on write, fuzzy search, and multilingual index design. Use when implementing search, syncing data to a search index, or reviewing search-related code.
---

# Skill: Elasticsearch
**Applies to:** Architect, Backend, Coder, Reviewer

---

## Architecture principle

```
PostgreSQL (source of truth) → sync on write → Elasticsearch (search index)
    → query → fast search results → fetch full data by ID → PostgreSQL returns the record
```

Never use Elasticsearch as primary storage. Always sync from PostgreSQL on create/update/delete.

## Service pattern

```typescript
@Injectable()
export class SearchService {
  constructor(private readonly esService: ElasticsearchService) {}

  async indexDocument(index: string, id: string, body: Record<string, unknown>) {
    return this.esService.index({ index, id, document: body });
  }

  async search(index: string, query: string, options?: {
    fields?: string[]; size?: number; from?: number; filters?: Record<string, unknown>;
  }) {
    const { fields = ['*'], size = 20, from = 0, filters } = options ?? {};
    const must: unknown[] = [
      { multi_match: { query, fields, type: 'best_fields', fuzziness: 'AUTO' } },
    ];
    if (filters) {
      Object.entries(filters).forEach(([key, value]) => must.push({ term: { [key]: value } }));
    }
    const result = await this.esService.search({
      index, from, size,
      query: { bool: { must } },
      highlight: { fields: Object.fromEntries(fields.map((f) => [f, {}])) },
    });
    return {
      hits: result.hits.hits.map((h) => ({ id: h._id, score: h._score, data: h._source })),
      total: result.hits.total,
    };
  }

  async deleteDocument(index: string, id: string) {
    return this.esService.delete({ index, id });
  }
}
```

## Sync pattern

```typescript
async create(dto: CreatePostDto): Promise<Post> {
  const post = await this.postRepo.save(this.postRepo.create(dto));
  await this.searchService.indexDocument('posts', post.id, {
    title: post.title, content: post.content, authorId: post.authorId, createdAt: post.createdAt,
  });
  return post;
}

async search(query: string, page = 1, limit = 20) {
  const results = await this.searchService.search('posts', query, {
    fields: ['title^3', 'content'], size: limit, from: (page - 1) * limit,
  });
  const ids = results.hits.map((h) => h.id);
  const posts = await this.postRepo.findBy({ id: In(ids) });
  return { items: posts, total: results.total };
}
```

## i18n + Elasticsearch

Index locale-specific fields (`title.en`, `title.ru`, etc.) and search with a locale-weighted
field list rather than a single shared field.

## Rules

### Coder
- Elasticsearch is search index only — PostgreSQL is source of truth.
- Sync on every create/update/delete.
- Use `fuzziness: 'AUTO'` for typo tolerance; weight fields with `^N` boost.
- Return full records from PostgreSQL, never raw ES documents.

### Reviewer
- Sync present on all write operations.
- No business logic relies on ES data — only IDs returned from search.
- Pagination applied to ES queries.
- Index mapping defined explicitly, not left to auto-mapping.
- `ELASTICSEARCH_URL` comes from env, never hardcoded.

### Architect
- Consider bulk indexing for initial data migration.
- Plan for ES being temporarily unavailable (degrade to DB search).
- One index per entity type.
