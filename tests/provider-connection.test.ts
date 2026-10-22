import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { once } from 'node:events';
import type { ClientRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { ConnectionTrace, createProviderSocket, describeProviderFailure } from '../server/provider-connection';

afterEach(() => { vi.useRealTimers(); });
describe('safe provider connection diagnostics', () => {
  it('still completes a real handshake and exchanges frames with the request observer installed', async () => {
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await once(server, 'listening');
    server.on('connection', peer => { peer.on('message', data => peer.send(data.toString())); });
    const socket = createProviderSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`);
    try {
      await once(socket, 'open');
      const response = once(socket, 'message'); socket.send('transport-check');
      expect((await response)[0].toString()).toBe('transport-check');
    } finally {
      socket.terminate(); await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
  it('tracks DNS, TCP, TLS and upgrade separately without logging the request', () => {
    vi.useFakeTimers();
    const trace = new ConnectionTrace(), request = new EventEmitter(), socket = new EventEmitter();
    trace.observe(request as ClientRequest); request.emit('socket', socket);
    const timeout = new Error('Opening handshake has timed out');
    expect(describeProviderFailure(timeout, trace).code).toBe('PROVIDER_DNS_TIMEOUT');
    socket.emit('lookup', null); expect(describeProviderFailure(timeout, trace).code).toBe('PROVIDER_TCP_TIMEOUT');
    socket.emit('connect'); expect(describeProviderFailure(timeout, trace).code).toBe('PROVIDER_TLS_TIMEOUT');
    socket.emit('secureConnect'); vi.advanceTimersByTime(8000);
    expect(describeProviderFailure(timeout, trace)).toMatchObject({ code: 'PROVIDER_UPGRADE_TIMEOUT', retryable: true, diagnostics: { stage: 'upgrade', elapsedMs: 8000 } });
  });
  it('keeps a failed DNS lookup in the DNS phase and preserves its safe error code', () => {
    const trace = new ConnectionTrace(), request = new EventEmitter(), socket = new EventEmitter();
    trace.observe(request as ClientRequest); request.emit('socket', socket);
    const error = Object.assign(new Error('contains private request data'), { code: 'ENOTFOUND' });
    socket.emit('lookup', error);
    expect(describeProviderFailure(error, trace)).toMatchObject({ code: 'PROVIDER_DNS_ENOTFOUND', diagnostics: { stage: 'dns', networkCode: 'ENOTFOUND' } });
  });
  it('does not retry certificate failures or weaken TLS verification', () => {
    const error = Object.assign(new Error('certificate check failed'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
    expect(describeProviderFailure(error)).toMatchObject({ code: 'PROVIDER_TLS_ERR_TLS_CERT_ALTNAME_INVALID', retryable: false });
  });
  it('never exposes raw error messages, signed URLs, unknown codes or credential-like values', () => {
    const secret = 'private-key-example';
    const error = Object.assign(new Error(`wss://example.test/?authorization=${secret}`), { code: secret });
    const output = JSON.stringify(describeProviderFailure(error));
    expect(output).not.toContain(secret); expect(output).not.toContain('authorization'); expect(output).not.toContain('example.test');
    expect(describeProviderFailure(error).diagnostics.networkCode).toBe('UNKNOWN');
  });
  it('records only bounded valid target addresses for correlating failed connection attempts', () => {
    const trace = new ConnectionTrace(), request = new EventEmitter(), socket = new EventEmitter();
    trace.observe(request as ClientRequest); request.emit('socket', socket);
    socket.emit('lookup', null, '192.0.2.1', 4); socket.emit('lookup', null, '192.0.2.1', 4);
    socket.emit('lookup', new Error('lookup failed'), '192.0.2.2', 4);
    socket.emit('lookup', null, 'signed-url-must-not-appear', 4);
    socket.emit('connectionAttempt', '192.0.2.1', 443, 4);
    socket.emit('connectionAttempt', '2001:db8::1', 443, 6);
    const failure = describeProviderFailure(new Error('Opening handshake has timed out'), trace);
    expect(failure.diagnostics).toMatchObject({ stage: 'tcp', resolvedAddresses: ['192.0.2.1'], attemptedAddresses: ['192.0.2.1', '2001:db8::1'] });
    for (let i = 2; i < 40; i++) socket.emit('connectionAttempt', `192.0.2.${i}`, 443, 4);
    expect(trace.attemptedAddresses).toHaveLength(16);
    expect(failure.diagnostics.attemptedAddresses).toEqual(['192.0.2.1', '2001:db8::1']);
    expect(JSON.stringify(failure)).not.toContain('signed-url-must-not-appear');
    socket.emit('connect'); socket.emit('secureConnect'); socket.emit('lookup', null, '192.0.2.40', 4);
    expect(trace.stage).toBe('upgrade');
  });
});
