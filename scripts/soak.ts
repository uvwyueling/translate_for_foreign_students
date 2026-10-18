import WebSocket from 'ws';
import { createApp } from '../server/app';
import type { AddressInfo } from 'node:net';
import type { ServerEvent } from '../shared/protocol';

// 只验证模拟后端与实际墙钟时间；不等同于浏览器、真实 API 或现场验收。
const duration = Number(process.env.SOAK_SECONDS ?? 2700);
if (!Number.isFinite(duration) || duration < 5) throw new Error('SOAK_SECONDS must be >= 5');
const { server, wss } = createApp({ maxSeconds: 30 });
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const started = Date.now();
let socket: WebSocket | undefined, ping: ReturnType<typeof setInterval> | undefined;
let done = false, sessions = 0, captions = 0, handoffs = 0, errors = 0;
function connect() {
  const ws = new WebSocket(origin.replace('http:', 'ws:') + '/api/ws', { origin }); socket = ws;
  ws.on('open', () => ws.send(JSON.stringify({ type: 'start', mode: 'mock', sessionId: `soak-${++sessions}` })));
  ws.on('message', data => {
    const event = JSON.parse(data.toString()) as ServerEvent;
    if (event.type === 'caption' && event.final) captions++;
    if (event.type === 'handoff') handoffs++;
    if (event.type === 'error') errors++;
  });
  ping = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping', at: Date.now() })); }, 2000);
  ws.on('error', () => { errors++; });
  ws.on('close', () => { clearInterval(ping); if (!done) setTimeout(connect, 100); });
}
connect();
await new Promise(resolve => setTimeout(resolve, duration * 1000));
done = true; clearInterval(ping); socket?.close();
for (const ws of wss.clients) ws.terminate();
await new Promise<void>(resolve => wss.close(() => resolve()));
await new Promise<void>(resolve => server.close(() => resolve()));
const report = { test: 'mock-backend-wall-clock-soak', seconds: (Date.now() - started) / 1000, sessions, finalCaptions: captions, handoffs, errors, rssMB: Math.round(process.memoryUsage().rss / 1024 / 1024) };
console.info(JSON.stringify(report, null, 2));
if (!captions || errors || (duration > 35 && !handoffs)) process.exitCode = 1;
