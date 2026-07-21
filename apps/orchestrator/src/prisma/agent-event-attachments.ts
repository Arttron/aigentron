import { AppConfigService } from '../config/app-config.service';

/**
 * `AgentEvent.attachments` is a real `String[]` column on Postgres but a
 * JSON-encoded `String` on SQLite (Prisma has no scalar-list support there —
 * see prisma/generate-sqlite-schema.mjs, docs/plan-single-container.md Phase
 * 2). These two helpers are the ONLY places that difference should ever be
 * handled; every read/write of the column goes through them.
 */

/** For a `create`/`update` payload: array on postgres, JSON string on sqlite. */
export function encodeAttachments(config: AppConfigService, attachments: string[]): string[] | string {
  return config.storageDriver === 'sqlite' ? JSON.stringify(attachments) : attachments;
}

/** For a value just read back: normalizes either shape to a plain array. */
export function decodeAttachments(config: AppConfigService, raw: unknown): string[] {
  if (config.storageDriver !== 'sqlite') return (raw as string[]) ?? [];
  if (typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
