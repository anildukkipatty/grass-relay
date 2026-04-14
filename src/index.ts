import http from 'node:http';
import { WebSocketServer } from 'ws';
import { handleGrassConnection } from './relay';
import { handleAppRequest } from './relay';

const PORT = parseInt(process.env.PORT ?? '4000', 10);

const server = http.createServer((req, res) => {
  handleAppRequest(req, res);
});

// GRASS connects here via WebSocket
const wss = new WebSocketServer({ server, path: '/grass-connect' });

wss.on('connection', (ws) => {
  handleGrassConnection(ws);
});

server.listen(PORT, () => {
  console.log(`[relay] listening on port ${PORT}`);
  console.log(`[relay] GRASS connects to: ws://localhost:${PORT}/grass-connect`);
  console.log(`[relay] App uses URLs like: http://localhost:${PORT}/s/<token>/...`);
});

server.on('error', (err) => {
  console.error('[relay] server error:', err);
  process.exit(1);
});

process.on('SIGINT', () => {
  console.log('\n[relay] shutting down');
  server.close(() => process.exit(0));
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
