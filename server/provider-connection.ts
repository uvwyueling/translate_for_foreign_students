import type { ClientRequest } from 'node:http';
import WebSocket from 'ws';
import { recordIp, runtimeDiagnostics } from './network-diagnostics.js';

type Stage = 'connection' | 'dns' | 'tcp' | 'tls' | 'upgrade' | 'open';
/** 仅记录阶段和耗时；不保留 URL、请求头、凭证或课堂内容。 */
export class ConnectionTrace {
  stage: Stage = 'dns';
  resolvedAddresses: string[] = [];
  attemptedAddresses: string[] = [];
  private startedAt = Date.now();
  observe(request: ClientRequest) {
    request.once('socket', socket => {
      socket.on('lookup', (error, address) => {
        if (!error) {
          if (this.stage === 'dns' || this.stage === 'tcp') this.stage = 'tcp';
          recordIp(this.resolvedAddresses, address);
        }
      });
      socket.on('connectionAttempt', address => recordIp(this.attemptedAddresses, address));
      socket.once('connect', () => { this.stage = 'tls'; });
      socket.once('secureConnect', () => { this.stage = 'upgrade'; });
    });
  }
  get elapsedMs() { return Math.max(0, Date.now() - this.startedAt); }
}
const traces = new WeakMap<WebSocket, ConnectionTrace>();
export function createProviderSocket(url: string): WebSocket {
  const trace = new ConnectionTrace();
  const socket = new WebSocket(url, {
    handshakeTimeout: 8000, maxPayload: 2_000_000,
    finishRequest: request => { trace.observe(request); request.end(); },
  });
  traces.set(socket, trace);
  socket.once('open', () => {
    trace.stage = 'open';
    console.info('provider_connection_open', { ...runtimeDiagnostics(), elapsedMs: trace.elapsedMs, resolvedAddresses: [...trace.resolvedAddresses], attemptedAddresses: [...trace.attemptedAddresses] });
  });
  return socket;
}

const NETWORK_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'ERR_SOCKET_CONNECTION_TIMEOUT']);
const TLS_CODES = new Set(['CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'ERR_TLS_CERT_ALTNAME_INVALID', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY']);
const STAGE_LABELS: Record<Stage, string> = { connection: '连接', dns: '域名解析', tcp: 'TCP 连接', tls: 'TLS 握手', upgrade: 'WebSocket 握手', open: '音频传输' };

export function describeProviderFailure(error: unknown, trace?: ConnectionTrace) {
  const value = error as { code?: unknown; message?: unknown } | null;
  const rawCode = typeof value?.code === 'string' ? value.code : '';
  const networkCode = NETWORK_CODES.has(rawCode) || TLS_CODES.has(rawCode) ? rawCode : 'UNKNOWN';
  const stage = ['ENOTFOUND', 'EAI_AGAIN'].includes(networkCode) ? 'dns' : TLS_CODES.has(networkCode) ? 'tls' : trace?.stage ?? 'connection';
  // ws 的超时错误没有 code。只判断固定文本，绝不输出原始错误消息（可能含鉴权 URL）。
  const timedOut = value?.message === 'Opening handshake has timed out' || ['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ERR_SOCKET_CONNECTION_TIMEOUT'].includes(networkCode);
  const code = `PROVIDER_${stage.toUpperCase()}_${timedOut ? 'TIMEOUT' : networkCode === 'UNKNOWN' ? 'FAILED' : networkCode}`;
  const message = `后端到讯飞的${STAGE_LABELS[stage]}${timedOut ? '超时' : '失败'}，${stage === 'open' ? '传输已中断' : '尚未开始传送课堂音频'}。请查看“运行数据与排查”中的具体错误码。`;
  return { code, message, retryable: !TLS_CODES.has(networkCode), diagnostics: { stage, networkCode, elapsedMs: trace?.elapsedMs ?? 0,
    resolvedAddresses: [...(trace?.resolvedAddresses ?? [])], attemptedAddresses: [...(trace?.attemptedAddresses ?? [])] } };
}
export function providerConnectionFailure(socket: WebSocket, error: unknown) {
  const failure = describeProviderFailure(error, traces.get(socket));
  console.warn('provider_connection_failed', { ...runtimeDiagnostics(), ...failure.diagnostics });
  return failure;
}
export function providerConnectionTimeout(socket: WebSocket) {
  return providerConnectionFailure(socket, new Error('Opening handshake has timed out'));
}
