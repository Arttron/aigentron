import { readFileSync } from 'node:fs';
import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { publicOrigin } from '../config/cors';

const PUBLIC_DEFAULT_LITELLM_KEY = 'sk-lds-master-dev';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * Boot-time self-check: say plainly when the instance is reachable from outside while still carrying dev defaults.
 * Advisory only (never blocks startup). `BIND_ADDRESS` is the host interface the compose stack publishes its ports
 * on (set by docker-compose.yml); when it's absent (minimal image, bare-metal) the app listens on all interfaces.
 */
@Injectable()
export class SecurityPostureService implements OnApplicationBootstrap {
  private readonly logger = new Logger('SecurityPosture');

  constructor(private readonly config: AppConfigService) {}

  /** Host interface the ports are published on: the compose entrypoint's hand-over file, else the env var. */
  private bindAddress(): string | undefined {
    try {
      const v = readFileSync('/tmp/lds-bind-address', 'utf8').trim();
      if (v) return v;
    } catch {
      /* not running under the compose entrypoint */
    }
    return process.env.BIND_ADDRESS?.trim() || undefined;
  }

  onApplicationBootstrap(): void {
    const publicUrl = publicOrigin(process.env.PUBLIC_URL);
    if (publicUrl) {
      this.logger.warn(
        `PUBLIC_URL=${publicUrl}: the dashboard is meant to be reachable from the internet. Make sure sign-in passwords are set ` +
          '(Settings → Security) — without one, anyone who finds the address controls the platform — and/or put it behind Cloudflare Access. See docs/remote-access.md.',
      );
    }
    const bind = this.bindAddress();
    const exposed = !bind || !LOOPBACK.has(bind);
    if (!exposed) {
      this.logger.log(`Ports are bound to ${bind} — reachable from this machine only.`);
      return;
    }
    this.logger.warn(
      `Reachable from the network (${bind ? `BIND_ADDRESS=${bind}` : 'listening on all interfaces'}): the API and dashboard have NO ` +
        'authentication. Keep this behind a VPN / firewall / authenticating proxy.',
    );
    if (!this.config.litellmManaged && this.config.litellmMasterKey === PUBLIC_DEFAULT_LITELLM_KEY) {
      this.logger.warn(
        'LITELLM_MASTER_KEY is the public default while LiteLLM is reachable: anyone on the network can spend your provider keys. ' +
          'Set a random LITELLM_MASTER_KEY (make init-env on a fresh install).',
      );
    }
    if (this.config.mcpHostEnabled && !this.config.mcpToken) {
      this.logger.warn('The MCP endpoint (/api/mcp) is enabled without MCP_TOKEN: set MCP_TOKEN or disable it with MCP_HOST_ENABLED=false.');
    }
  }
}
