import { randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AppConfigService } from '../config/app-config.service';
import { SecretJsonFile } from '../security/secret-json-file';
import { aggregate, isLineDown, listIds, parseModelRef, pickModel, unavailable, type SharedModel } from './local-llm';
import { LocalBridgeService } from './local-bridge.service';
import { LocalDevicesService } from './local-devices.service';

interface ModelsAnswer {
  models?: { backend: string; id: string }[];
  problems?: string[];
}

/**
 * A model that runs on a person's computer, offered to the server as an OpenAI-compatible endpoint (`/api/local-llm/v1`): LiteLLM (so every agent) can use it
 * like any provider — the request goes over the line the local agent holds open, and the answer streams back. The person chooses what is shared, on that computer
 * (`aigentron llm allow …`); the server only ever sees the models the computer lists.
 */
@Injectable()
export class LocalLlmService {
  private keyFile?: SecretJsonFile<{ key: string }>;
  private cache = new Map<string, { at: number; models: SharedModel[] }>();

  constructor(
    private readonly config: AppConfigService,
    private readonly bridge: LocalBridgeService,
    private readonly devices: LocalDevicesService,
  ) {}

  private get store(): SecretJsonFile<{ key: string }> {
    return (this.keyFile ??= new SecretJsonFile<{ key: string }>(join(this.config.secretsDir, 'local-llm-key.json'), {
      missing: { key: '' },
      parse: (raw) => ({ key: typeof (raw as { key?: unknown })?.key === 'string' ? (raw as { key: string }).key : '' }),
    }));
  }

  /** The bearer LiteLLM presents (created on first use; the dashboard shows it to operators so they can add the provider). */
  key(): string {
    const cur = this.store.read().key;
    if (cur) return cur;
    const key = `llm_${randomBytes(24).toString('hex')}`;
    this.store.write({ key });
    return key;
  }

  authorized(header: string | undefined): boolean {
    const given = header?.startsWith('Bearer ') ? header.slice(7) : '';
    const a = Buffer.from(given);
    const b = Buffer.from(this.key());
    return a.length === b.length && timingSafeEqual(a, b);
  }

  baseUrl(): string {
    return `${this.config.approvalsApiUrl.replace(/\/$/, '')}/api/local-llm/v1`;
  }

  /** The models shared right now by the online computers (each computer asked at most every 20 s). */
  async shared(): Promise<SharedModel[]> {
    const out: SharedModel[] = [];
    const now = Date.now();
    for (const id of this.bridge.onlineIds()) {
      const dev = this.devices.list().find((d) => d.id === id);
      if (!dev) continue;
      let hit = this.cache.get(id);
      if (!hit || now - hit.at > 20_000) {
        const r = await this.bridge.request(id, 'llm.models', {}, 8_000);
        const data = (r.ok ? r.data : undefined) as ModelsAnswer | undefined;
        hit = { at: now, models: (data?.models ?? []).map((m) => ({ deviceId: id, deviceLabel: dev.label, backend: m.backend, id: m.id })) };
        this.cache.set(id, hit);
      }
      out.push(...hit.models);
    }
    return out;
  }

  async modelsResponse(): Promise<Record<string, unknown>> {
    const ids = listIds(await this.shared());
    return { object: 'list', data: ids.map((id) => ({ id, object: 'model', owned_by: 'local-agent' })) };
  }

  private fail(res: Response, status: number, message: string): void {
    if (res.headersSent) {
      res.end();
      return;
    }
    res.status(status).json({ error: { message, type: 'local_agent_error' } });
  }

  async chat(req: Request, res: Response): Promise<void> {
    const body = (req.body ?? {}) as { model?: unknown; stream?: unknown } & Record<string, unknown>;
    if (typeof body.model !== 'string' || !body.model) return this.fail(res, 400, 'model is required');
    const target = pickModel(await this.shared(), body.model);
    if (!target) {
      const u = unavailable('no-model', `("${body.model}": run aigentron llm allow … on a connected computer)`);
      return this.fail(res, u.status, u.message);
    }
    const wantStream = body.stream === true;
    // usage numbers come back only when asked for (the agent's budget and the stats rely on them)
    const request = { ...body, model: parseModelRef(body.model).model, stream_options: { include_usage: true, ...((body as { stream_options?: object }).stream_options ?? {}) } };

    const chunks: string[] = [];
    if (wantStream) {
      res.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.flushHeaders();
    }
    const job = this.bridge.stream(
      target.deviceId,
      'llm.chat',
      (id) => ({ id, backend: target.backend, request }),
      (_name, data) => {
        const payload = (data as { data?: unknown }).data;
        if (typeof payload !== 'string') return;
        if (wantStream) res.write(`data: ${payload}\n\n`);
        else chunks.push(payload);
      },
    );
    // the caller went away (LiteLLM timed out, the task was stopped): stop the model
    res.on('close', () => {
      if (!res.writableEnded) job.cancel();
    });
    const r = await job.done;
    if (!r.ok) {
      this.cache.delete(target.deviceId); // the next request asks the computer again
      const err = r.error ?? '';
      const u = /stopped answering/.test(err) ? unavailable('stalled') : isLineDown(err) ? unavailable('offline') : unavailable('failed', err);
      return this.fail(res, u.status, u.message);
    }
    if (wantStream) {
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.json(aggregate(chunks, request.model));
  }
}
