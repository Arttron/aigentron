/**
 * The frames of the local-agent protocol (v1). The contract is the fixtures in packages/shared/protocol/local-agent — the Go daemon (apps/local-agent) and
 * the tests of this folder both load them.
 */
export const PROTO = 1;
export const PROTO_MIN = 1;
export const PING_SEC = 25;

export interface Frame {
  type: string;
  id?: string;
  op?: string;
  args?: unknown;
  ok?: boolean;
  data?: unknown;
  error?: string;
  name?: string;
  protoMin?: number;
  proto?: number;
  version?: string;
  os?: string;
  arch?: string;
  host?: string;
  /** the revision of the global rules the agent holds (0 / absent: none) */
  configRev?: number;
  serverVersion?: string;
  pingSec?: number;
  code?: string;
  message?: string;
}

const TYPES = new Set(['hello', 'welcome', 'refuse', 'ping', 'pong', 'command', 'result', 'event']);

/** Parse one text frame; null for anything that is not a frame of a known type. */
export function decodeFrame(text: string): Frame | null {
  try {
    const f = JSON.parse(text) as Frame;
    return f && typeof f === 'object' && typeof f.type === 'string' && TYPES.has(f.type) ? f : null;
  } catch {
    return null;
  }
}

export const encodeFrame = (f: Frame): string => JSON.stringify(f);

/** The server's answer to a `hello`: a welcome, or a refusal (the protocol ranges do not meet). */
export function negotiate(hello: Frame, serverVersion: string): Frame {
  const proto = Number(hello.proto);
  const min = Number(hello.protoMin ?? hello.proto);
  if (!Number.isInteger(proto) || !Number.isInteger(min) || proto < 1 || min > proto) return { type: 'refuse', code: 'bad_hello', message: 'unreadable hello' };
  if (proto < PROTO_MIN) return { type: 'refuse', code: 'proto_too_old', message: 'this local agent is too old for the server — update it' };
  if (min > PROTO) return { type: 'refuse', code: 'proto_too_new', message: 'this local agent needs a newer server — update the server' };
  return { type: 'welcome', proto: Math.min(proto, PROTO), serverVersion, pingSec: PING_SEC };
}
