import { join } from 'node:path';
import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { SecretJsonFile } from '../security/secret-json-file';
import { normalizeRunLimits, runLimitsFromEnv, type RunLimits } from './run-limits-core';

/** Settings → General → Run limits: a JSON file next to the other small settings, read live (the next run uses a saved change). */
@Injectable()
export class RunLimitsService {
  private store?: SecretJsonFile<Partial<RunLimits>>;

  constructor(private readonly config: AppConfigService) {}

  private get file(): SecretJsonFile<Partial<RunLimits>> {
    return (this.store ??= new SecretJsonFile<Partial<RunLimits>>(join(this.config.secretsDir, 'run-limits.json'), {
      missing: {},
      parse: (raw) => (raw && typeof raw === 'object' ? (raw as Partial<RunLimits>) : {}),
    }));
  }

  /** The values the environment implies (what "reset" returns to). */
  defaults(): RunLimits {
    return runLimitsFromEnv(this.config);
  }

  get(): RunLimits {
    return normalizeRunLimits(this.file.read(), this.defaults());
  }

  save(input: unknown): RunLimits {
    const limits = normalizeRunLimits(input, this.get());
    this.file.write(limits);
    return limits;
  }

  /** Forget what was saved: back to the environment's values. */
  reset(): RunLimits {
    this.file.write({});
    return this.get();
  }
}
