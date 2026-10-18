import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { WebSocketServer } from 'ws';
import { allowedOrigin, attachBridge, health, readConfig, tokenMatches, type BridgeConfig } from './bridge.js';
import { runNetworkCheck } from './network-check.js';

export function createApp(config: BridgeConfig = readConfig(), serveStatic = false, networkCheck: () => Promise<unknown> = runNetworkCheck) {
  let checkingNetwork = false, lastNetworkCheckAt: number | undefined;
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const url = new URL(req.url ?? '/', 'http://localhost'), path = url.pathname;
    // 查询参数在 Vercel 重写至 /api/server 后仍然保留；口令只走 HTTPS 请求头。
    if ((path === '/api/health' || path === '/api/server') && url.searchParams.get('check') === 'network') {
      res.setHeader('Content-Type', 'application/json');
      if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); res.writeHead(405).end(JSON.stringify({ error: 'METHOD_NOT_ALLOWED' })); return; }
      if (!allowedOrigin(req, config.origin)) { res.writeHead(403).end(JSON.stringify({ error: 'FORBIDDEN_ORIGIN' })); return; }
      const authorization = req.headers.authorization;
      if (!tokenMatches(authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined, config.accessToken)) { res.writeHead(401).end(JSON.stringify({ error: 'UNAUTHORIZED' })); return; }
      if (checkingNetwork || (lastNetworkCheckAt !== undefined && Date.now() - lastNetworkCheckAt < 30000)) {
        res.setHeader('Retry-After', '30'); res.writeHead(429).end(JSON.stringify({ error: 'CHECK_RATE_LIMIT' })); return;
      }
      checkingNetwork = true; lastNetworkCheckAt = Date.now();
      try { const result = await networkCheck(); if (!res.destroyed) res.end(JSON.stringify(result)); }
      catch { if (!res.destroyed) res.writeHead(500).end(JSON.stringify({ error: 'NETWORK_CHECK_FAILED' })); }
      finally { checkingNetwork = false; }
      return;
    }
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
