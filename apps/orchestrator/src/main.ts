import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AppConfigService } from './config/app-config.service';
import { CloudflareAccessService } from './access/cloudflare-access.service';
import { AccessService } from './access/access.service';
import { WebServerService } from './web/web-server.service';

/**
 * Keep the orchestrator alive on benign socket write failures. A broken pipe
 * (EPIPE) / reset (ECONNRESET) from a client, child process, or upstream that
 * went away surfaces as an unhandled 'error' on a Socket and would otherwise
 * crash the whole process (taking the API + queue with it). These are safe to
 * log and ignore; any other uncaught error still crashes so the container
 * restarts into a clean state.
 */
function installProcessGuards(): void {
  const benign = new Set(['EPIPE', 'ECONNRESET']);
  process.on('uncaughtException', (err) => {
    const code = (err as NodeJS.ErrnoException).code;
    if (code && benign.has(code)) {
      Logger.warn(`Ignoring benign socket error: ${code}`, 'Process');
      return;
    }
    Logger.error(`Uncaught exception — exiting`, (err as Error).stack, 'Process');
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    const code = (reason as NodeJS.ErrnoException)?.code;
    if (code && benign.has(code)) {
      Logger.warn(`Ignoring benign socket rejection: ${code}`, 'Process');
      return;
    }
    // A genuine unhandled rejection means a broken flow — surface it and exit so
    // the container restarts clean, rather than running on in a half-broken state.
    Logger.error(`Unhandled promise rejection — exiting`, String((reason as Error)?.stack ?? reason), 'Process');
    process.exit(1);
  });
}

async function bootstrap(): Promise<void> {
  installProcessGuards();
  const app = await NestFactory.create(AppModule);
  const config = app.get(AppConfigService);
  // Domain allow-list (Settings → General → Access). Applies to everything, the dashboard files included. Local names, IPs and
  // single-word hosts always pass, so port forwarding / ssh -L / opening the server by IP behave as before.
  const access = app.get(AccessService);
  app.use((req: { headers: { host?: string } }, res: { status: (n: number) => { type: (t: string) => { send: (b: string) => void } } }, next: () => void) => {
    if (access.allows(req.headers.host)) return next();
    res.status(421).type('text/plain').send('This address is not served here. If you own this server, allow the domain in Settings → General → Access, or open it by IP / localhost.');
  });
  // Cloudflare Access (Settings → General): under a real domain name every request must carry Access's signed token.
  const cfAccess = app.get(CloudflareAccessService);
  app.use(async (req: { headers: Record<string, string | string[] | undefined> }, res: { status: (n: number) => { type: (t: string) => { send: (b: string) => void } } }, next: () => void) => {
    const host = req.headers.host as string | undefined;
    if (!cfAccess.required(host) || (await cfAccess.check(req.headers)).ok) return next();
    res.status(403).type('text/plain').send('Cloudflare Access sign-in is required for this address.');
  });
  app.setGlobalPrefix('api');
  app.enableCors({
    origin: config.corsOrigin,
    credentials: true,
    // Browser MCP clients read the session id off the initialize response and
    // echo it back on the mcp-session-id header for the rest of the session.
    // (Request headers are reflected by default, so we only expose this one.)
    exposedHeaders: ['Mcp-Session-Id'],
  });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );
  app.enableShutdownHooks();

  await listenWithRetry(app, config.port);
  // port 80 / 443 (HTTPS once a certificate is installed) — see web/web-server.service.ts; never fatal
  void app.get(WebServerService).start();
  Logger.log(`Orchestrator listening on http://0.0.0.0:${config.port}/api`, 'Bootstrap');
}

/**
 * Bind the port, retrying on EADDRINUSE. Under `nest --watch` a recompile can
 * spawn the new process before the old one releases the port; without a retry
 * the new (current-code) process dies and the STALE one keeps serving. Retrying
 * lets the newest process win once the old one exits.
 */
async function listenWithRetry(
  app: Awaited<ReturnType<typeof NestFactory.create>>,
  port: number,
  attempts = 8,
): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      await app.listen(port, process.env.ORCHESTRATOR_HOST?.trim() || '0.0.0.0'); // ORCHESTRATOR_HOST=127.0.0.1: this machine only (e.g. behind a tunnel)
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EADDRINUSE' && i < attempts) {
        Logger.warn(
          `Port ${port} busy (EADDRINUSE) — retry ${i}/${attempts - 1} in 1s (stale --watch process releasing?)`,
          'Bootstrap',
        );
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      throw err;
    }
  }
}

void bootstrap();
