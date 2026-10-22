import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { WebSocketServer } from 'ws';
import type { ServerEvent } from '../shared/protocol';

const provider = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('../server/provider-connection', async importOriginal => ({
  ...await importOriginal<typeof import('../server/provider-connection')>(), createProviderSocket: provider.create,
}));
import { attachBridge } from '../server/bridge';

class Peer extends EventEmitter {
  readyState = 1; bufferedAmount = 0; sent: ServerEvent[] = [];
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; this.emit('close'); }
  terminate() { this.close(); }
  message(value: unknown, binary = false) { this.emit('message', binary ? value : Buffer.from(JSON.stringify(value)), binary); }
}
let client: Peer, upstream: Peer;
beforeEach(() => {
  vi.useFakeTimers(); provider.create.mockReset();
  const server = new EventEmitter(); client = new Peer(); upstream = new Peer(); upstream.readyState = 0;
  provider.create.mockReturnValue(upstream);
  attachBridge(server as WebSocketServer, { credentials: { appId: 'app', apiKey: 'key', apiSecret: 'secret' }, accessToken: 'classroom-test', maxSeconds: 60 });
  server.emit('connection', client);
});
afterEach(() => { client.close(); vi.clearAllTimers(); vi.useRealTimers(); });
const start = (segmentation = 'continuous', token = 'classroom-test') => client.message({ type: 'start', sessionId: 'startup-test', mode: 'live', segmentation, token });

describe('backend startup acknowledgement without network access', () => {
  it.each(['continuous', 'pause'])('acknowledges %s startup before opening the upstream connection', segmentation => {
    provider.create.mockImplementationOnce(() => {
      expect(client.sent).toEqual([{ type: 'connecting', sessionId: 'startup-test' }]);
      return upstream;
    });
    start(segmentation);
    expect(provider.create).toHaveBeenCalledTimes(1);
    client.message({ type: 'ping', at: 123 });
    expect(client.sent.at(-1)).toEqual({ type: 'pong', at: 123 });
    expect(client.sent.some(event => event.type === 'ready')).toBe(false);
    client.message(Buffer.alloc(1280), true);
    expect(upstream.sent).toHaveLength(0);
    upstream.readyState = 1; upstream.emit('open');
    expect(client.sent.at(-1)).toEqual({ type: 'ready', sessionId: 'startup-test', mode: 'live' });
  });
  it('rejects a wrong classroom token without acknowledging or contacting the provider', () => {
    start('continuous', 'wrong-token');
    expect(client.sent).toEqual([{ type: 'error', code: 'UNAUTHORIZED', message: expect.any(String), retryable: false }]);
    expect(provider.create).not.toHaveBeenCalled();
  });
  it('ignores a late upstream open after the classroom is stopped', () => {
    start(); client.close(); upstream.readyState = 1; upstream.emit('open');
    expect(client.sent).toEqual([{ type: 'connecting', sessionId: 'startup-test' }]);
  });
});
