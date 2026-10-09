import { networkInterfaces } from 'node:os';

/** This host's own addresses, re-read at most every 30s (interfaces rarely change). */
let cache: { at: number; list: string[] } = { at: 0, list: [] };
export function ownAddresses(): string[] {
  if (Date.now() - cache.at > 30_000) {
    cache = { at: Date.now(), list: Object.values(networkInterfaces()).flatMap((l) => (l ?? []).map((i) => i.address)) };
  }
  return cache.list;
}
