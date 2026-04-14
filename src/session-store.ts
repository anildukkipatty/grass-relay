import { WebSocket } from 'ws';
import http from 'node:http';

export interface PendingRequest {
  res: http.ServerResponse;
  isSSE: boolean;
  headersSent: boolean;
}

export interface GrassSession {
  token: string;
  ws: WebSocket;
  pending: Map<string, PendingRequest>;
}

const sessions = new Map<string, GrassSession>();

export function createSession(ws: WebSocket, token: string): GrassSession {
  const session: GrassSession = { token, ws, pending: new Map() };
  sessions.set(token, session);
  return session;
}

export function getSession(token: string): GrassSession | undefined {
  return sessions.get(token);
}

export function deleteSession(token: string): void {
  sessions.delete(token);
}

export function allSessions(): IterableIterator<GrassSession> {
  return sessions.values();
}
