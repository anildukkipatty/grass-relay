import { WebSocket } from 'ws';
import http from 'node:http';
import { randomUUID } from 'crypto';
import { createSession, getSession, deleteSession, PendingRequest } from './session-store';
import { GrassToRelayFrame, RelayToGrassFrame } from './types';
import { config } from './config';

const ALLOWED_HEADERS = 'Content-Type, Last-Event-ID, X-Relay-Token, Authorization, X-Client-Version, X-Daytona-Skip-Preview-Warning';

// --- GRASS-facing WebSocket handler ---

export function handleGrassConnection(ws: WebSocket): void {
  console.log('[grass] new connection — waiting for registration');

  // session is null until GRASS sends a valid register frame
  let session: ReturnType<typeof createSession> | null = null;

  ws.on('message', (raw) => {
    let frame: GrassToRelayFrame;
    try {
      frame = JSON.parse(raw.toString()) as GrassToRelayFrame;
    } catch {
      console.warn('[grass] unparseable frame, ignoring');
      return;
    }

    // ---- Registration phase ----
    if (!session) {
      if (frame.type !== 'register') {
        console.warn('[grass] expected register frame, got:', frame.type);
        ws.close();
        return;
      }

      const { token } = frame;

      if (!token || typeof token !== 'string' || token.length < 16) {
        const errFrame: RelayToGrassFrame = { type: 'register_error', reason: 'Invalid token' };
        ws.send(JSON.stringify(errFrame));
        ws.close();
        return;
      }

      const existing = getSession(token);
      if (existing) {
        if (existing.ws.readyState === WebSocket.OPEN || existing.ws.readyState === WebSocket.CONNECTING) {
          // Old connection is still alive — evict it so the restarted container can take over.
          console.warn(`[grass] token=${token} already has an active connection; evicting old session for reconnect`);
          // Fail any pending requests on the old session before dropping it.
          for (const [, pending] of existing.pending) {
            if (!pending.headersSent) {
              pending.res.writeHead(502, {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
                'Access-Control-Allow-Headers': ALLOWED_HEADERS,
                'Content-Type': 'application/json',
              });
            }
            if (!pending.res.writableEnded) {
              pending.res.end(JSON.stringify({ error: 'relay reconnected' }));
            }
          }
          existing.ws.terminate();
          deleteSession(token);
        } else {
          // WebSocket is CLOSING or CLOSED but the close event hasn't fired yet — clean it up now.
          console.warn(`[grass] token=${token} stale session (readyState=${existing.ws.readyState}); replacing`);
          deleteSession(token);
        }
      }

      session = createSession(ws, token);
      console.log(`[grass] registered — token=${token}`);
      const ackFrame: RelayToGrassFrame = { type: 'registered' };
      ws.send(JSON.stringify(ackFrame));
      return;
    }

    // ---- Normal request/response phase ----
    if (frame.type === 'register') {
      // Already registered — ignore duplicate register frames
      return;
    }

    if (frame.type === 'push_notification') {
      const grassApiUrl = config.grass_api_url;
      const relaySecret = config.relay_secret;
      console.log(`[push] received push_notification frame from token=${session.token}`);
      if (!grassApiUrl || !relaySecret) {
        console.error(`[push] SKIP: grass_api_url=${grassApiUrl} relay_secret=${relaySecret ? 'set' : 'MISSING'}`);
        return;
      }
      console.log(`[push] forwarding to ${grassApiUrl}/notifications/internal`);
      fetch(`${grassApiUrl}/notifications/internal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-relay-secret': relaySecret },
        body: JSON.stringify({ token: session.token, title: frame.title, body: frame.body, data: frame.data }),
      }).then(async (res) => {
        const text = await res.text();
        console.log(`[push] grass-api responded: ${res.status} ${text}`);
      }).catch((err) => {
        console.error(`[push] failed to forward push_notification: ${err.message}`);
      });
      return;
    }

    const pending = session.pending.get(frame.requestId);
    if (!pending) {
      // Can happen if the app closed the connection before GRASS responded
      return;
    }

    if (frame.type === 'response_start') {
      if (!pending.headersSent) {
        pending.res.writeHead(frame.statusCode, {
          ...frame.headers,
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': ALLOWED_HEADERS,
        });
        pending.headersSent = true;
        pending.isSSE = (frame.headers['content-type'] ?? '').includes('text/event-stream');
      }
      return;
    }

    if (frame.type === 'data') {
      if (!pending.res.writableEnded) {
        pending.res.write(frame.chunk);
      }
      return;
    }

    if (frame.type === 'end') {
      if (!pending.res.writableEnded) {
        pending.res.end();
      }
      session.pending.delete(frame.requestId);
      return;
    }

    if (frame.type === 'error') {
      console.warn(`[grass] error for requestId=${frame.requestId}: ${frame.message}`);
      if (!pending.headersSent) {
        pending.res.writeHead(502, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': ALLOWED_HEADERS,
          'Content-Type': 'application/json',
        });
      }
      if (!pending.res.writableEnded) {
        if (pending.isSSE) {
          pending.res.write(`event: error\ndata: ${JSON.stringify({ error: frame.message })}\n\n`);
        }
        pending.res.end();
      }
      session.pending.delete(frame.requestId);
      return;
    }
  });

  ws.on('close', () => {
    if (!session) return; // never registered — nothing to clean up

    // Guard: if this session was evicted and the token re-registered by a new WS,
    // don't delete the new session from the store.
    const current = getSession(session.token);
    if (current && current.ws !== ws) {
      console.log(`[grass] close event for evicted WS (token=${session.token}); skipping deleteSession`);
      return;
    }

    console.log(`[grass] disconnected — token=${session.token}`);
    // Fail all pending requests
    for (const [, pending] of session.pending) {
      if (!pending.headersSent) {
        pending.res.writeHead(502, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': ALLOWED_HEADERS,
          'Content-Type': 'application/json',
        });
      }
      if (!pending.res.writableEnded) {
        if (pending.isSSE) {
          pending.res.write(`event: error\ndata: ${JSON.stringify({ error: 'relay disconnected' })}\n\n`);
        }
        pending.res.end();
      }
    }
    deleteSession(session.token);
  });

  ws.on('error', (err) => {
    console.error(`[grass] ws error: ${err.message}`);
  });
}

// --- App-facing HTTP handler ---

export function handleAppRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = req.url ?? '/';
  const method = req.method ?? 'GET';

  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': ALLOWED_HEADERS,
  };

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return;
  }

  // Health check (no token required)
  if (method === 'GET' && url === '/health') {
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  // Extract token from path prefix: /s/<token>/rest/of/path
  const tokenMatch = url.match(/^\/s\/([^/]+)(\/.*)?$/);
  if (!tokenMatch) {
    res.writeHead(400, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing relay token. Use /s/<token>/... paths.' }));
    return;
  }

  const token = tokenMatch[1];
  const grassPath = tokenMatch[2] ?? '/';

  const session = getSession(token);
  if (!session) {
    res.writeHead(404, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No GRASS server connected for this token.' }));
    return;
  }

  if (session.ws.readyState !== WebSocket.OPEN) {
    res.writeHead(502, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'GRASS server connection is not open.' }));
    return;
  }

  const requestId = randomUUID();

  console.log(`[req] ${method} ${grassPath} token=${token}`);

  // Forward headers, stripping hop-by-hop headers
  const forwardHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') forwardHeaders[k] = v;
    else if (Array.isArray(v)) forwardHeaders[k] = v.join(', ');
  }
  delete forwardHeaders['host'];
  delete forwardHeaders['connection'];
  delete forwardHeaders['x-relay-token'];

  const pending: PendingRequest = {
    res,
    isSSE: false,
    headersSent: false,
  };
  session.pending.set(requestId, pending);

  // Clean up if app closes the response connection before GRASS responds.
  // We listen on res.socket (not req) so this only fires when the client
  // has actually gone away, not when the request body is simply done sending.
  res.socket?.once('close', () => {
    if (!pending.res.writableEnded) {
      session.pending.delete(requestId);
    }
  });

  // Read body then dispatch
  let body = '';
  req.on('data', (chunk) => { body += chunk.toString(); });
  req.on('end', () => {
    const frame: RelayToGrassFrame = {
      requestId,
      type: 'request',
      method,
      path: grassPath,
      headers: forwardHeaders,
      body,
    };

    try {
      session.ws.send(JSON.stringify(frame));
    } catch (err: any) {
      session.pending.delete(requestId);
      if (!res.headersSent) {
        res.writeHead(502, { ...cors, 'Content-Type': 'application/json' });
      }
      if (!res.writableEnded) {
        res.end(JSON.stringify({ error: `Failed to forward to GRASS: ${err.message}` }));
      }
    }
  });
}
