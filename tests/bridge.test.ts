import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { createApp } from '../server/app';
import type { BridgeConfig } from '../server/bridge';
import type { ServerEvent } from '../shared/protocol';

const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => { for (const app of apps.splice(0)) { for (const client of app.wss.clients) client.terminate(); await new Promise<void>(resolve => app.wss.close(() => resolve())); await new Promise<void>(resolve => app.server.close(() => resolve())); } });
async function setup(config: BridgeConfig = { maxSeconds: 60 }, networkCheck?: () => Promise<unknown>) {
  const app = createApp(config, false, networkCheck); apps.push(app);
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  return { app, origin, url: origin.replace('http:', 'ws:') + '/api/ws' };
}
async function client(url: string, origin: string) {
  const socket = new WebSocket(url, { origin }); const events: ServerEvent[] = [];
  socket.on('message', data => events.push(JSON.parse(data.toString())));
  await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  return { socket, events };
}
const until = async (predicate: () => boolean, timeout = 4000) => {
  const end = Date.now() + timeout;
  while (!predicate()) { if (Date.now() > end) throw new Error('Timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
};
describe('real WebSocket transport', () => {
  it('connects mock session, revises a sentence, pings, and stops all late events', async () => {
    const { url, origin } = await setup(); const { socket, events } = await client(url, origin);
    socket.send(JSON.stringify({ type: 'start', sessionId: 'first', mode: 'mock' }));
    await until(() => events.some(e => e.type === 'ready'));
    socket.send(JSON.stringify({ type: 'ping', at: 123 }));
    await until(() => events.some(e => e.type === 'pong'));
    await until(() => events.some(e => e.type === 'mock-speech'));
    const captions = events.filter(e => e.type === 'caption');
    expect(captions).toHaveLength(2); expect(captions[0].id).toBe(captions[1].id);
    socket.send(JSON.stringify({ type: 'stop' }));
    await new Promise(resolve => socket.once('close', resolve));
    const length = events.length; await new Promise(resolve => setTimeout(resolve, 100)); expect(events).toHaveLength(length);
    const second = await client(url, origin); second.socket.send(JSON.stringify({ type: 'start', sessionId: 'second', mode: 'mock' }));
    await until(() => second.events.some(e => e.type === 'ready' && e.sessionId === 'second'));
    second.socket.close();
  });
  it('refuses real mode without credentials and never substitutes mock results', async () => {
    const { url, origin } = await setup(); const { socket, events } = await client(url, origin);
    socket.send(JSON.stringify({ type: 'start', sessionId: 'real', mode: 'live' }));
    await until(() => events.some(e => e.type === 'error'));
    expect(events).toEqual([{ type: 'error', code: 'NOT_CONFIGURED', message: expect.any(String), retryable: false }]);
  });
  it('rejects cross-origin upgrades', async () => {
    const { url } = await setup(); const socket = new WebSocket(url, { origin: 'https://untrusted.example' });
    const status = await new Promise<number | undefined>(resolve => { socket.on('unexpected-response', (_req, res) => { res.resume(); resolve(res.statusCode); socket.terminate(); }); socket.on('error', () => {}); });
    expect(status).toBe(403);
  });
  it('reports configuration without secrets', async () => {
    const { origin } = await setup(); const response = await fetch(origin + '/api/health');
    expect(await response.json()).toMatchObject({ ok: true, liveConfigured: false, mockAvailable: true });
  });
  it('requires a POST, the classroom token and the allowed origin before running a network check', async () => {
    const check = vi.fn(async () => ({ checks: [] }));
    const { origin } = await setup({ accessToken: 'classroom-test' }, check);
    const url = origin + '/api/health?check=network';
    expect((await fetch(url)).status).toBe(405);
    expect((await fetch(url, { method: 'POST', headers: { origin } })).status).toBe(401);
    expect((await fetch(url, { method: 'POST', headers: { origin, Authorization: 'Bearer wrong' } })).status).toBe(401);
    expect((await fetch(url, { method: 'POST', headers: { origin: 'https://untrusted.example', Authorization: 'Bearer classroom-test' } })).status).toBe(403);
    expect(check).not.toHaveBeenCalled();
  });
  it('serves only the checker result through the rewritten endpoint and limits repeated requests', async () => {
    let finish!: (value: unknown) => void;
    const check = vi.fn(() => new Promise<unknown>(resolve => { finish = resolve; }));
    const { origin } = await setup({ accessToken: 'classroom-test' }, check);
    const url = origin + '/api/server?check=network';
    const options = { method: 'POST', headers: { origin, Authorization: 'Bearer classroom-test' } };
    const first = fetch(url, options); await until(() => check.mock.calls.length === 1);
    expect((await fetch(url, options)).status).toBe(429);
    finish({ runtimeRegion: 'test', checks: [{ id: 'control', ok: true }] });
    const response = await first; expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ runtimeRegion: 'test', checks: [{ id: 'control', ok: true }] });
    expect((await fetch(url, options)).status).toBe(429);
    expect(check).toHaveBeenCalledTimes(1);
  });
});
