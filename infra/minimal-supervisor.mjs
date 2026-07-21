#!/usr/bin/env node
// ----------------------------------------------------------------------
// Minimal/single-container profile process supervisor (docs/plan-single-
// container.md Phase 4). Runs the two top-level processes this image needs —
// the dashboard (Next standalone server) and the orchestrator — and restarts
// either on an unexpected exit. litellm is NOT a third top-level process here:
// it's already spawned/restarted by the orchestrator itself (LitellmManagedService,
// Phase 3), so this script only supervises one level, not three.
//
// Deliberately no dependency on a real init system (s6-overlay, tini) — with
// just two children and no per-service isolation requirement, a plain script
// that restarts a crashed child and forwards signals is the simpler form that
// does the same job (see docs/plan-single-container.md's Phase 4 note).
// ----------------------------------------------------------------------
import { spawn } from 'node:child_process';

const RESTART_DELAY_MS = 2000;

const services = [
  {
    name: 'dashboard',
    command: 'node',
    args: ['apps/dashboard-standalone/apps/dashboard/server.js'],
    cwd: '/app',
    env: { PORT: process.env.DASHBOARD_PORT ?? '3000', HOSTNAME: '0.0.0.0' },
  },
  {
    name: 'orchestrator',
    command: 'node',
    args: ['apps/orchestrator/dist/main.js'],
    cwd: '/app',
    env: {},
  },
];

let shuttingDown = false;
const children = new Map();

function start(svc) {
  if (shuttingDown) return;
  const child = spawn(svc.command, svc.args, {
    cwd: svc.cwd,
    env: { ...process.env, ...svc.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.set(svc.name, child);
  const prefix = `[${svc.name}]`;
  child.stdout?.on('data', (d) => process.stdout.write(prefixLines(prefix, d)));
  child.stderr?.on('data', (d) => process.stderr.write(prefixLines(prefix, d)));
  child.on('exit', (code, signal) => {
    children.delete(svc.name);
    if (shuttingDown) return;
    console.error(`${prefix} exited (code=${code} signal=${signal}) — restarting in ${RESTART_DELAY_MS}ms`);
    setTimeout(() => start(svc), RESTART_DELAY_MS);
  });
  console.log(`${prefix} started (pid ${child.pid})`);
}

function prefixLines(prefix, buf) {
  return buf
    .toString()
    .split('\n')
    .filter((_, i, arr) => i < arr.length - 1 || arr[i] !== '')
    .map((line) => `${prefix} ${line}\n`)
    .join('');
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal} — stopping ${children.size} child process(es)`);
  const exits = [...children.values()].map(
    (child) => new Promise((resolve) => child.once('exit', resolve)),
  );
  for (const child of children.values()) child.kill(signal);
  await Promise.race([Promise.all(exits), new Promise((r) => setTimeout(r, 10_000))]);
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

for (const svc of services) start(svc);
