import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';
import { tokenFromWebSocketRequest, userForToken } from './lib/auth.js';
import { betaInviteFromRequest } from './lib/beta.js';
import { getMap, requireMapView } from './lib/maps.js';

function send(socket, message) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

export function setupWebSocket(server, db, config) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  const hasBetaAccess = (req) => !config.betaInviteRequired || Boolean(betaInviteFromRequest(req, config, db));
  server.on('upgrade', (req, socket, head) => {
    let pathname;
    try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { return; }
    if (pathname !== '/ws') return;
    if (!hasBetaAccess(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const user = userForToken(db, tokenFromWebSocketRequest(req));
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, user));
  });

  wss.on('connection', (ws, req, user) => {
    ws.upgradeReq = req;
    ws.userId = user.id;
    ws.mapSubscriptions = new Set();
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    send(ws, { type: 'ready', protocolVersion: 1, userId: user.id, businessEvents: false });
    ws.on('message', (data) => {
      if (!hasBetaAccess(req)) {
        send(ws, { type: 'error', code: 'BETA_REQUIRED', message: '内测通行码已失效，请重新输入' });
        ws.close(1008, 'BETA_REQUIRED');
        return;
      }
      let message;
      try { message = JSON.parse(data.toString()); } catch {
        return send(ws, { type: 'error', code: 'INVALID_JSON' });
      }
      try {
        if (message.type === 'subscribe') {
          const input = z.object({ mapId: z.string().uuid() }).parse(message);
          const map = getMap(db, input.mapId);
          requireMapView(db, map, user.id);
          ws.mapSubscriptions.add(map.id);
          return send(ws, { type: 'subscribed', mapId: map.id });
        }
        if (message.type === 'unsubscribe') {
          const input = z.object({ mapId: z.string().uuid() }).parse(message);
          ws.mapSubscriptions.delete(input.mapId);
          return send(ws, { type: 'unsubscribed', mapId: input.mapId });
        }
        send(ws, { type: 'error', code: 'BUSINESS_EVENTS_NOT_ENABLED' });
      } catch (error) {
        send(ws, { type: 'error', code: error.code || 'SUBSCRIPTION_REJECTED', message: error.message });
      }
    });
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!hasBetaAccess(ws.upgradeReq)) {
        send(ws, { type: 'error', code: 'BETA_REQUIRED', message: '内测通行码已失效，请重新输入' });
        ws.close(1008, 'BETA_REQUIRED');
        continue;
      }
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30_000);
  heartbeat.unref();
  wss.on('close', () => clearInterval(heartbeat));
  return wss;
}
