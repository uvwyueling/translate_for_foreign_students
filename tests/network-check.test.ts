import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter, once } from 'node:events';
import { createServer, type AddressInfo, type Socket } from 'node:net';
import { checkTcp } from '../server/network-check';

afterEach(() => { vi.useRealTimers(); });
describe('bounded TCP connectivity check', () => {
  it('confirms a TCP connection without sending an application payload', async () => {
    const server = createServer(); const data = vi.fn();
    server.on('connection', socket => socket.on('data', data));
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    try {
      const result = await checkTcp({ id: 'test', host: '127.0.0.1', port: (server.address() as AddressInfo).port, family: 4 });
      expect(result).toMatchObject({ ok: true, errorCode: null }); expect(data).not.toHaveBeenCalled();
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it('ends an unresolved connection at its deadline and ignores late events', async () => {
    vi.useFakeTimers(); const socket = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    const result = checkTcp({ id: 'test', host: 'example.test', port: 443, family: 4 }, 4000, () => socket as unknown as Socket);
    socket.emit('lookup', null, '192.0.2.1', 4); await vi.advanceTimersByTimeAsync(4000);
    const snapshot = await result;
    expect(snapshot).toMatchObject({ ok: false, elapsedMs: 4000, resolvedFamilies: [4], resolvedAddresses: ['192.0.2.1'], errorCode: 'TIMEOUT' });
    socket.emit('lookup', null, '192.0.2.2', 4); socket.emit('connectionAttempt', '192.0.2.2', 443, 4);
    expect(snapshot.resolvedAddresses).toEqual(['192.0.2.1']); expect(snapshot.attemptedAddresses).toEqual([]);
    socket.emit('connect'); expect(socket.destroy).toHaveBeenCalledTimes(1);
  });
  it('reports only allowlisted error codes and never raw error details', async () => {
    const error = Object.assign(new Error('private transport request'), { code: 'ECONNREFUSED' });
    const result = await checkTcp({ id: 'test', host: 'example.test', port: 443, family: 0 }, 4000, () => { throw error; });
    expect(result.errorCode).toBe('ECONNREFUSED'); expect(JSON.stringify(result)).not.toContain('private transport request');
  });
  it('preserves valid DNS and attempted addresses without keeping arbitrary error strings', async () => {
    const socket = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    const result = checkTcp({ id: 'test', host: 'example.test', port: 443, family: 0 }, 4000, () => socket as unknown as Socket);
    socket.emit('lookup', null, '192.0.2.1', 4); socket.emit('lookup', null, '192.0.2.1', 4);
    socket.emit('lookup', new Error('lookup failed'), '192.0.2.2', 4);
    socket.emit('connectionAttempt', '192.0.2.1', 443, 4);
    socket.emit('connectionAttempt', 'private-signed-url', 443, 4);
    socket.emit('error', Object.assign(new Error('private transport request'), { code: 'ECONNREFUSED' }));
    expect(await result).toMatchObject({ resolvedAddresses: ['192.0.2.1'], attemptedAddresses: ['192.0.2.1'], errorCode: 'ECONNREFUSED' });
    expect(JSON.stringify(await result)).not.toContain('private-');
  });
});
