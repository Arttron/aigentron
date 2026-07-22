import { io, type Socket } from 'socket.io-client';
import { SOCKET_URL } from './config';

/**
 * Process-wide Socket.IO singleton. The orchestrator auto-joins every client to
 * the `global` room; per-task rooms are joined explicitly via subscribe:task.
 */
let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) {
    socket = io(SOCKET_URL, { reconnection: true });
  }
  return socket;
}
