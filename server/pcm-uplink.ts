import WebSocket from 'ws';
import { audioRequest } from './xfyun.js';
import { nextPcmDeadline, PCM_FRAME_MS } from '../shared/audio-pacing.js';
import type { UplinkDiagnostics } from '../shared/protocol.js';

/** 网络可能把若干音频帧集中交付；向讯飞始终按 40 ms 节奏发送，短时背压先等待。 */
export class PcmUplink {
  private queue: Buffer[] = [];
  private seq = 0;
  private stopped = false;
  private started = false;
  private nextSendAt?: number;
  private blockedSince?: number;
  private timer?: ReturnType<typeof setTimeout>;
  private timerDueAt?: number;
  private receivedFrames = 0;
  private peakQueuedFrames = 0;
  private maxTimerDelayMs = 0;
  constructor(private socket: WebSocket, private appId: string, private fail: (code: string, message: string, retryable: boolean, uplink?: UplinkDiagnostics) => void) {}
  get diagnostics(): UplinkDiagnostics {
    return { receivedFrames: this.receivedFrames, forwardedFrames: this.seq, queuedFrames: this.queue.length, peakQueuedFrames: this.peakQueuedFrames,
      networkBufferedBytes: this.socket.bufferedAmount, blockedMs: this.blockedSince === undefined ? 0 : Math.max(0, Date.now() - this.blockedSince), maxTimerDelayMs: this.maxTimerDelayMs };
  }
  start() {
    if (this.stopped || this.started) return;
    this.started = true; this.pump();
  }
  push(pcm: Buffer) {
    if (this.stopped) return;
    this.receivedFrames++;
    if (this.queue.length >= 150) { this.abort('UPSTREAM_INPUT_BACKLOG', '后端待发送音频达到 6 秒上限，已停止采音。请查看云端发送诊断后重试。'); return; }
    this.queue.push(pcm); this.peakQueuedFrames = Math.max(this.peakQueuedFrames, this.queue.length);
    this.pump();
  }
  private schedule(delayMs: number) {
    const delay = Math.max(1, Math.ceil(delayMs)), due = Date.now() + delay;
    this.timerDueAt = due;
    this.timer = setTimeout(() => {
      this.timer = undefined; this.timerDueAt = undefined;
      this.maxTimerDelayMs = Math.max(this.maxTimerDelayMs, Date.now() - due);
      this.pump();
    }, delay);
  }
  private pump() {
    // 新到的帧也能推动已到期的发送，不必依赖迟到的定时器回调。
    if (this.timer !== undefined) {
      if (this.timerDueAt !== undefined) this.maxTimerDelayMs = Math.max(this.maxTimerDelayMs, Date.now() - this.timerDueAt);
      clearTimeout(this.timer); this.timer = undefined; this.timerDueAt = undefined;
    }
    if (this.stopped || !this.started || this.socket.readyState !== WebSocket.OPEN || !this.queue.length) return;
    const now = Date.now();
    if (this.socket.bufferedAmount > 64000) {
      this.blockedSince ??= now;
      if (now - this.blockedSince >= 6000) this.abort('UPSTREAM_BACKPRESSURE', '讯飞连接写缓冲持续积压超过 6 秒，已停止采音。请查看云端发送诊断后重试。');
      else this.schedule(PCM_FRAME_MS);
      return;
    }
    this.blockedSince = undefined;
    if (this.nextSendAt !== undefined && now < this.nextSendAt) { this.schedule(this.nextSendAt - now); return; }
    this.nextSendAt = nextPcmDeadline(this.nextSendAt, now);
    this.socket.send(JSON.stringify(audioRequest(this.appId, this.queue.shift()!, this.seq++)));
    if (this.queue.length) this.schedule(this.nextSendAt - now);
  }
  private abort(code: string, message: string) {
    const diagnostics = this.diagnostics;
    this.stop(); this.fail(code, message, false, diagnostics);
  }
  stop(sendEnd = false) {
    if (this.stopped) return;
    this.stopped = true; clearTimeout(this.timer); this.timer = undefined; this.timerDueAt = undefined; this.queue = [];
    if (sendEnd && this.seq > 0 && this.socket.readyState === WebSocket.OPEN && this.socket.bufferedAmount <= 64000)
      this.socket.send(JSON.stringify(audioRequest(this.appId, Buffer.alloc(0), this.seq, true)));
  }
}
