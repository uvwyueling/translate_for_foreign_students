import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { WebSocketServer } from 'ws';
import { allowedOrigin, attachBridge, health, readConfig, type BridgeConfig } from './bridge.js';

export function createApp(config: BridgeConfig = readConfig(), serveStatic = false) {
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path.startsWith('/api/health') || path === '/api/server') {
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(health(config))); return;
    }
    if (serveStatic) {
      try {
        const root = resolve('dist');
        const file = resolve(root, '.' + (path === '/' || path === '/subtitles' ? '/index.html' : decodeURIComponent(path)));
        if (!file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
        const content = await readFile(file);
        const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
        res.setHeader('Content-Type', types[extname(file)] ?? 'application/octet-stream');
        res.end(content); return;
      } catch { /* 只返回通用错误，不记录内容或凭证。 */ }
    }
    res.writeHead(404).end('Not found');
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  server.on('upgrade', (request, socket, head) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (!['/api/ws', '/api/server'].includes(path) || !allowedOrigin(request, config.origin)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request));
  });
  attachBridge(wss, config);
  return { server, wss };
}
