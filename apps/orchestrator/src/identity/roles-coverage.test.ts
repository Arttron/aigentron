import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { ROLES_KEY } from './roles.decorator';
import { SettingsController } from '../settings/settings.controller';
import { AgentRegistryController } from '../agent-registry/agent-registry.controller';
import { ProvidersController } from '../providers/providers.controller';
import { TasksController } from '../tasks/tasks.controller';
import { AttachmentsController } from '../attachments/attachments.controller';
import { UpdateController } from '../update/update.controller';
import { McpController } from '../mcp/mcp.controller';
import { ChannelsController } from '../channels/channels.controller';

// Nest RequestMethod: GET 0, POST 1, PUT 2, DELETE 3, PATCH 4
const MUTATING = new Set([1, 2, 3, 4]);

const CONTROLLERS = [
  SettingsController, AgentRegistryController, ProvidersController, TasksController,
  AttachmentsController, UpdateController, McpController, ChannelsController,
];

/** Mutating handlers deliberately open to any signed-in user (reviewer may act on them). Keep this list short. */
const OPEN: string[] = [];

describe('every mutating handler declares @Roles', () => {
  for (const C of CONTROLLERS) {
    it(C.name, () => {
      const missing: string[] = [];
      let seen = 0;
      for (const name of Object.getOwnPropertyNames(C.prototype)) {
        if (name === 'constructor') continue;
        const fn = (C.prototype as Record<string, unknown>)[name] as object;
        if (typeof fn !== 'function') continue;
        const method = Reflect.getMetadata('method', fn);
        if (method === undefined || !MUTATING.has(method)) continue;
        seen += 1;
        const roles = Reflect.getMetadata(ROLES_KEY, fn) ?? Reflect.getMetadata(ROLES_KEY, C);
        const key = `${C.name}.${name}`;
        if (OPEN.includes(key)) continue;
        if (!Array.isArray(roles) || roles.length === 0) missing.push(key);
      }
      expect(seen).toBeGreaterThan(0); // the metadata is really read
      expect(missing).toEqual([]);
    });
  }
});
