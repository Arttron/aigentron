import { join } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { SecretJsonFile } from '../security/secret-json-file';
import { LocalBridgeService } from './local-bridge.service';
import { DEFAULT_RULES, normalizeRules, type LocalRules } from './local-rules';

interface Stored {
  rev: number;
  rules: LocalRules;
}

/**
 * The global rules (`<secretsDir>/local-agent-rules.json`, with a revision): edited on Add-ons → Local agent and synced to every computer — at once to those online,
 * and to the others when they connect (their `hello` says which revision they hold). A computer keeps the last synced copy in a file, so the rules work offline.
 */
@Injectable()
export class LocalRulesService {
  private readonly logger = new Logger(LocalRulesService.name);
  private store?: SecretJsonFile<Stored>;

  constructor(
    private readonly config: AppConfigService,
    private readonly bridge: LocalBridgeService,
  ) {
    bridge.onReady((deviceId, info) => {
      const { rev } = this.get();
      if (rev > 0 && info.configRev !== rev) void this.pushTo(deviceId);
    });
  }

  private get file(): SecretJsonFile<Stored> {
    return (this.store ??= new SecretJsonFile<Stored>(join(this.config.secretsDir, 'local-agent-rules.json'), {
      missing: { rev: 0, rules: structuredClone(DEFAULT_RULES) },
      pretty: true,
      parse: (raw) => {
        const r = raw as Partial<Stored> | null;
        const n = normalizeRules(r?.rules);
        return { rev: Number.isInteger(r?.rev) && (r!.rev as number) >= 0 ? (r!.rev as number) : 0, rules: n.ok ? n.rules : structuredClone(DEFAULT_RULES) };
      },
    }));
  }

  /** rev 0 = never saved (the defaults apply, nothing is pushed). */
  get(): Stored {
    return this.file.read();
  }

  /** Validate and save (the revision goes up), then push to the computers that are online. */
  async set(input: unknown): Promise<{ ok: true; rev: number; rules: LocalRules } | { ok: false; error: string }> {
    const n = normalizeRules(input);
    if (!n.ok) return n;
    const rev = this.get().rev + 1;
    this.file.write({ rev, rules: n.rules });
    await Promise.all(this.bridge.onlineIds().map((id) => this.pushTo(id)));
    return { ok: true, rev, rules: n.rules };
  }

  private async pushTo(deviceId: string): Promise<void> {
    const { rev, rules } = this.get();
    const r = await this.bridge.request(deviceId, 'config.set', { rev, rules }, 15_000);
    if (r.ok) this.bridge.setConfigRev(deviceId, rev);
    else this.logger.warn(`Rules revision ${rev} were not applied on device ${deviceId}: ${r.error}`);
  }
}
