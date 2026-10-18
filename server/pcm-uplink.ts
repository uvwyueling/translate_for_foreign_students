import WebSocket from 'ws';
import { audioRequest } from './xfyun.js';

/** 网络可能把若干音频帧集中交付；向讯飞始终按 40 ms 节奏发送，短时背压先等待。 */
export class PcmUplink {
  private queue: Buffer[] = [];
  private seq = 0;
  private stopped = false;
  private lastSendAt?: number;
  private blockedSince?: number;
  private timer?: ReturnType<typeof setInterval>;
  constructor(private socket: WebSocket, private appId: string, private fail: (code: string, message: string, retryable: boolean) => void) {}
  start() {
    if (!this.stopped && !this.timer) this.timer = setInterval(() => this.pump(), 40);
  }
  push(pcm: Buffer) {
    if (this.stopped) return;
    if (this.queue.length >= 150) { this.abort('UPSTREAM_INPUT_BACKLOG', '后端向讯飞发送音频持续积压超过 6 秒，已停止采音。请检查部署区域和服务网络后重试。'); return; }
    this.queue.push(pcm); this.pump();
  }
  private pump() {
    if (this.stopped || this.socket.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    if (this.socket.bufferedAmount > 64000) {
      this.blockedSince ??= now;
      if (now - this.blockedSince >= 6000) this.abort('UPSTREAM_BACKPRESSURE', '后端到讯飞的发送阻塞持续超过 6 秒，已停止采音。请检查部署区域和服务网络后重试。');
      return;
    }
    this.blockedSince = undefined;
    if (!this.queue.length || (this.lastSendAt !== undefined && now - this.lastSendAt < 40)) return;
    this.lastSendAt = now;
    this.socket.send(JSON.stringify(audioRequest(this.appId, this.queue.shift()!, this.seq++)));
  }
  private abort(code: string, message: string) { this.stop(); this.fail(code, message, false); }
  stop(sendEnd = false) {
    if (this.stopped) return;
    this.stopped = true; clearInterval(this.timer); this.queue = [];
    if (sendEnd && this.seq > 0 && this.socket.readyState === WebSocket.OPEN && this.socket.bufferedAmount <= 64000)
      this.socket.send(JSON.stringify(audioRequest(this.appId, Buffer.alloc(0), this.seq, true)));
  }
}
