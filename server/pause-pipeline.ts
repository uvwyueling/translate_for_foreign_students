import WebSocket from 'ws';
import { audioRequest, signedUrl, VendorDecoder, type Credentials } from './xfyun.js';
import type { ServerEvent } from '../shared/protocol.js';

type Frame = { pcm: Buffer; endMs: number; voiced: boolean };
type SocketFactory = (url: string) => WebSocket;
/** 实验模式：停顿后发送结束帧，收完旧会话结果后再建下一条上游连接。 */
export class PausePipeline {
  private socket?: WebSocket;
  private decoder?: VendorDecoder;
  private queue: Frame[] = [];
  private sentEnds: number[] = [];
  private timelineMs = 0;
  private segment = 0;
  private audioSeq = 0;
  private inputSeq = 0;
  private voicedMs = 0;
  private silentMs = 0;
  private ending = false;
  private stopped = false;
  private announced = false;
  private timer?: ReturnType<typeof setInterval>;
  private deadline?: ReturnType<typeof setTimeout>;
  constructor(
    private credentials: Credentials,
    private emit: (event: ServerEvent) => void,
    private ready: () => void,
    private fail: (code: string, message: string, retryable: boolean) => void,
    private emitAudio = true,
    private makeSocket: SocketFactory = url => new WebSocket(url, { handshakeTimeout: 8000, maxPayload: 2_000_000 }),
  ) {}
  start() { this.open(); }
  push(pcm: Buffer) {
    if (this.stopped) return;
    this.timelineMs += 40;
    let sum = 0;
    for (let i = 0; i < pcm.length; i += 2) sum += (pcm.readInt16LE(i) / 32768) ** 2;
    const frame = { pcm, endMs: this.timelineMs, voiced: Math.sqrt(sum / (pcm.length / 2)) > 0.008 };
    this.queue.push(frame);
    if (this.queue.length > 150) { this.abort('SEGMENT_BACKLOG', '句间连接等待超过 6 秒，已停止采音。请重试或改用连续同传。', false); return; }
    if (!this.socket) {
      this.trimIdleSilence();
      if (this.queue.some(item => item.voiced)) this.open();
    }
    this.pump();
  }
  private trimIdleSilence() {
    // 新会话尚未开始时只保留约 200 ms 前导静音，不积攒过时的静音。
    const firstVoice = this.queue.findIndex(item => item.voiced);
    if (firstVoice < 0) this.queue = this.queue.slice(-5);
    else if (firstVoice > 5) this.queue.splice(0, firstVoice - 5);
  }
  private open() {
    if (this.stopped || this.socket) return;
    this.inputSeq = 0; this.voicedMs = 0; this.silentMs = 0; this.sentEnds = []; this.ending = false;
    const segment = ++this.segment;
    const socket = this.makeSocket(signedUrl(this.credentials)); this.socket = socket;
    this.decoder = new VendorDecoder('pipeline', event => {
      if (this.stopped || this.socket !== socket) return;
      if (event.type === 'error') { this.emit(event); this.stop(); return; }
      if (event.type === 'caption' || event.type === 'recognition') {
        const index = Math.max(0, Math.ceil(event.endMs / 40) - 1);
        const endMs = event.endMs > 0 ? this.sentEnds[index] ?? 0 : 0;
        this.emit(event.type === 'caption' ? { ...event, id: `piece:${segment}:${event.id}`, endMs } : { ...event, endMs });
      } else if (event.type === 'audio') this.emit({ ...event, seq: this.audioSeq++ });
      else this.emit(event);
    }, this.emitAudio);
    this.deadline = setTimeout(() => { if (this.socket === socket) this.abort('SEGMENT_CONNECT_TIMEOUT', '句间服务连接超时，请重试。', true); }, 10000);
    socket.on('open', () => {
      if (this.stopped || this.socket !== socket) return;
      clearTimeout(this.deadline);
      if (!this.announced) { this.announced = true; this.ready(); }
      // 积压音频也按 40 ms 节奏发送，避免突发回放给云端。
      this.timer = setInterval(() => this.pump(), 40);
      this.pump();
    });
    socket.on('message', raw => {
      if (this.stopped || this.socket !== socket) return;
      try {
        const more = this.decoder!.accept(raw.toString());
        if (!more && !this.stopped) this.finish(socket);
      } catch { this.abort('SEGMENT_PROTOCOL', '分句结果或音频顺序异常，请重试或改用连续同传。', false); }
    });
    socket.on('unexpected-response', (_request, response) => {
      response.resume();
      if (this.socket === socket && !this.stopped) this.abort(`PROVIDER_HTTP_${response.statusCode}`, '同传服务拒绝连接，请检查权限、额度和凭证。', false);
    });
    socket.on('error', () => { if (this.socket === socket && !this.stopped) this.abort('SEGMENT_NETWORK', '句间服务连接中断，正在重试；中断内容不会补译。', true); });
    socket.on('close', () => { if (this.socket === socket && !this.stopped) this.abort('SEGMENT_CLOSED', '句间服务意外结束，正在重试；中断内容不会补译。', true); });
  }
  private lastSendAt = 0;
  private pump() {
    const socket = this.socket;
    if (this.stopped || !socket || socket.readyState !== WebSocket.OPEN || this.ending || !this.queue.length) return;
    // push 和定时器可能同时调用；限制同一段内的发送速率。
    if (Date.now() - this.lastSendAt < 35) return;
    if (socket.bufferedAmount > 64000) { this.abort('SEGMENT_NETWORK_BACKLOG', '网络发送积压，正在重新连接。', true); return; }
    const frame = this.queue.shift()!;
    this.lastSendAt = Date.now(); this.sentEnds.push(frame.endMs);
    socket.send(JSON.stringify(audioRequest(this.credentials.appId, frame.pcm, this.inputSeq++)));
    if (frame.voiced) { this.voicedMs += 40; this.silentMs = 0; }
    else this.silentMs += 40;
    if (this.voicedMs >= 120 && this.silentMs >= 800) {
      this.ending = true; clearInterval(this.timer); this.timer = undefined;
      socket.send(JSON.stringify(audioRequest(this.credentials.appId, Buffer.alloc(0), this.inputSeq, true)));
      this.deadline = setTimeout(() => { if (this.socket === socket) this.abort('SEGMENT_RESULT_TIMEOUT', '本段翻译等待过久，请重试或改用连续同传。', false); }, 8000);
    }
  }
  private finish(socket: WebSocket) {
    if (this.socket !== socket) return;
    clearInterval(this.timer); clearTimeout(this.deadline);
    this.socket = undefined; this.decoder = undefined; this.sentEnds = []; this.ending = false; this.lastSendAt = 0;
    socket.close(); const timer = setTimeout(() => socket.terminate(), 1000); timer.unref();
    this.trimIdleSilence();
    if (this.queue.some(frame => frame.voiced)) this.open();
  }
  private abort(code: string, message: string, retryable: boolean) {
    this.stop(); this.fail(code, message, retryable);
  }
  checkAudioTimeout() { this.decoder?.checkAudioTimeout(); }
  stop() {
    if (this.stopped) return;
    this.stopped = true; clearInterval(this.timer); clearTimeout(this.deadline);
    const socket = this.socket; this.socket = undefined; this.decoder = undefined; this.queue = []; this.sentEnds = [];
    if (socket) { socket.close(); const timer = setTimeout(() => socket.terminate(), 1000); timer.unref(); }
  }
}
