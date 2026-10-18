import { MAX_CAPTIONS, upsertCaption, type Caption, type Mode, type Phase, type ServerEvent, type SpeechMode, type Segmentation } from '../../shared/protocol';
import { Microphone } from '../audio/capture';
import { AudioPlayer } from '../audio/player';
import { waitForLocalEnglishVoice } from '../audio/local-voice';
import { emptyMetrics, sample, summarize, type Metrics } from './metrics';

export interface ClassroomState {
  phase: Phase; mode: Mode; speechMode: SpeechMode; segmentation: Segmentation; captions: Caption[]; draft: string; level: number;
  microphone: 'unchecked' | 'checking' | 'ok' | 'silent' | 'error';
  service: 'unchecked' | 'ok' | 'error'; liveConfigured: boolean;
  message: string; detail: string; playbackError: string; queueSeconds: number; playing: boolean;
  volume: number; metrics: Metrics; projectionOpen: boolean;
}
export const initialState = (): ClassroomState => ({
  phase: 'idle', mode: 'mock', speechMode: 'provider', segmentation: 'continuous', captions: [], draft: '', level: 0, microphone: 'unchecked',
  service: 'unchecked', liveConfigured: false, message: '先完成课前检查，再开始课堂。', detail: '',
  playbackError: '', queueSeconds: 0, playing: false, volume: 0.8, metrics: emptyMetrics(), projectionOpen: false,
});
export const phaseLabels: Record<Phase, string> = { idle: '待开始', checking: '课前检查中', connecting: '正在连接', running: '课堂进行中', paused: '已暂停', reconnecting: '正在重连', error: '需要处理', ended: '课堂已结束' };
export function browserCapabilities() {
  return window.isSecureContext && !!navigator.mediaDevices?.getUserMedia && !!window.AudioContext && !!window.AudioWorkletNode && !!window.WebSocket;
}
export class ClassroomController {
  private disposed = false;
  private state = initialState();
  private listeners = new Set<() => void>();
  private microphone = new Microphone();
  private player = new AudioPlayer(() => this.patch({ queueSeconds: this.player.seconds, playing: this.player.isPlaying }), message => {
    this.player.clear(true);
    if (message.includes('60 秒')) this.fail(message, 'AUDIO_QUEUE_LIMIT');
    else this.patch({ playbackError: message });
  }, waitMs => sample(this.state.metrics.audioQueueWaitMs, waitMs), waitMs => {
    sample(this.state.metrics.localSpeechStartMs, waitMs);
    this.patch({ metrics: { ...this.state.metrics } });
  });
  private socket?: WebSocket;
  private sessionId = '';
  private generation = 0;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private retries = 0;
  private token = '';
  private ready = false;
  private runningWanted = false;
  private lastPong = 0;
  private recoveryAt = 0;
  private frameTimes: number[] = [];
  private partialSeen = new Set<string>();
  private finalSeen = new Set<string>();
  private spokenFinalIds = new Set<string>();
  private localSpeechSeq = 0;
  private firstCaptionAt = new Map<string, number>();
  private captionTimedIds = new Set<string>();
  private levelAt = Date.now();
  private startedAt = 0;
  private connectionAt = 0;
  private channelId = crypto.randomUUID();
  private channel?: BroadcastChannel;
  private projection?: Window | null;
  private ticker: ReturnType<typeof setInterval>;
  constructor() {
    if ('BroadcastChannel' in window) {
      this.channel = new BroadcastChannel(`classroom-${this.channelId}`);
      this.channel.onmessage = e => { if (e.data?.type === 'request') this.broadcast(); };
    }
    this.ticker = setInterval(() => this.tick(), 1000);
  }
  getSnapshot = () => this.state;
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private patch(update: Partial<ClassroomState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...update };
    this.listeners.forEach(fn => fn()); this.broadcast();
  }
  private broadcast() {
    // 投影只收到显示所需的数据，绝不包含口令和音频。
    this.channel?.postMessage({ type: 'snapshot', captions: this.state.captions, draft: this.state.draft, phase: this.state.phase, mode: this.state.mode, at: Date.now() });
  }
  setMode(mode: Mode) { if (!this.runningWanted && this.state.phase !== 'checking') this.patch({ mode }); }
  setSpeechMode(speechMode: SpeechMode) { if (!this.runningWanted && this.state.phase !== 'checking') this.patch({ speechMode }); }
  setSegmentation(segmentation: Segmentation) { if (!this.runningWanted && this.state.phase !== 'checking') this.patch({ segmentation }); }
  setToken(token: string) { this.token = token; }
  setVolume(volume: number) { this.player.setVolume(volume); this.patch({ volume }); }
  async check() {
    if (this.runningWanted || this.state.phase === 'checking') return;
    if (!browserCapabilities()) { this.fail('浏览器不支持必要功能。请在 HTTPS 页面或本机 localhost 使用新版 Edge / Chrome。', 'BROWSER_UNSUPPORTED'); return; }
    const generation = ++this.generation;
    this.patch({ phase: 'checking', microphone: 'checking', service: 'unchecked', message: '请对麦克风说几句话，检查将在 8 秒后结束。', detail: '' });
    let heard = false;
    const healthTask = this.checkHealth().then(ok => ok ? this.probeConnection() : false);
    try {
      await this.microphone.start(() => {}, level => {
        if (generation !== this.generation) return;
        heard ||= level > 0.008;
        this.patch({ level, microphone: heard ? 'ok' : 'checking' });
      }, () => { if (generation === this.generation) this.fail('麦克风被断开或浏览器暂停采音，请检查后重试。', 'MICROPHONE_INTERRUPTED'); });
      if (generation !== this.generation) return;
      setTimeout(() => {
        if (generation !== this.generation) return;
        this.microphone.stop();
        this.patch({ phase: 'idle', level: 0, microphone: heard ? 'ok' : 'silent', message: heard ? '麦克风有输入。请试听英文，并打开字幕窗口。' : '未检测到明显声音，请检查麦克风与系统输入音量。' });
      }, 8000);
    } catch (error) { if (generation === this.generation) this.micFailure(error); }
    await healthTask;
  }
  async checkHealth() {
    try {
      const response = await fetch('/api/health', { signal: AbortSignal.timeout(6000) });
      if (!response.ok) throw new Error();
      const health = await response.json();
      if (health.ok !== true) throw new Error();
      this.patch({ service: 'ok', liveConfigured: health.liveConfigured === true });
      return true;
    } catch { this.patch({ service: 'error', liveConfigured: false }); return false; }
  }
  private probeConnection(): Promise<boolean> {
    return new Promise(resolve => {
      const url = new URL('/api/ws', location.href); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(url);
      const timer = setTimeout(() => finish(false), 7000);
      const finish = (ok: boolean) => { clearTimeout(timer); socket.onclose = null; socket.onerror = null; socket.onmessage = null; socket.close(); this.patch({ service: ok ? 'ok' : 'error' }); resolve(ok); };
      socket.onopen = () => socket.send(JSON.stringify({ type: 'start', mode: 'mock', sessionId: crypto.randomUUID() }));
      socket.onmessage = event => { try { if (JSON.parse(event.data).type === 'ready') finish(true); } catch { finish(false); } };
      socket.onclose = () => finish(false); socket.onerror = () => finish(false);
    });
  }
  async testAudio() {
    if (this.runningWanted) return;
    this.patch({ playbackError: '' });
    try { await this.player.test(this.state.mode === 'live' && this.state.speechMode === 'local'); }
    catch { this.patch({ playbackError: '无法播放测试音，请检查浏览器播放权限和系统输出。' }); }
  }
  async resumeAudio() {
    try { await this.player.unlock(); this.patch({ playbackError: '' }); }
    catch { this.patch({ playbackError: '音频仍无法启动，请检查电脑声音设置。' }); }
  }
  async start() {
    if (this.runningWanted || this.state.phase === 'checking') return;
    if (!browserCapabilities()) { this.fail('浏览器能力不足，请使用 HTTPS 与新版 Edge / Chrome。', 'BROWSER_UNSUPPORTED'); return; }
    const fresh = ['idle', 'ended'].includes(this.state.phase);
    if (fresh) this.patch({ metrics: emptyMetrics(), captions: [], draft: '' });
    this.runningWanted = true;
    const generation = ++this.generation;
    this.retries = 0; this.startedAt = Date.now();
    this.player.clear(true);
    this.patch({ phase: 'connecting', playbackError: '', detail: '', message: '正在开启麦克风并连接课堂服务…' });
    try {
      await this.player.unlock();
      if (generation !== this.generation) return;
      if (this.state.mode === 'live' && this.state.speechMode === 'local') {
        const voice = await waitForLocalEnglishVoice();
        if (generation !== this.generation) return;
        if (!voice) { this.fail('未找到本机英语语音，请安装英语语音包或选择“讯飞英文语音”。', 'LOCAL_VOICE_UNAVAILABLE'); return; }
      }
      await this.microphone.start(frame => this.sendFrame(frame), level => {
        if (generation !== this.generation) return;
        this.levelAt = Date.now(); this.patch({ level, microphone: level > 0.008 ? 'ok' : this.state.microphone });
      }, () => { if (generation === this.generation) this.fail('麦克风已断开或采音被浏览器暂停，请检查设备后手动重试。', 'MICROPHONE_INTERRUPTED'); });
      if (generation !== this.generation) return;
      this.levelAt = Date.now();
      this.connect();
    } catch (error) { if (generation === this.generation) this.micFailure(error); }
  }
  private micFailure(error: unknown) {
    const name = error instanceof DOMException ? error.name : '';
    this.fail(name === 'NotAllowedError' ? '麦克风未授权，请在浏览器地址栏允许使用麦克风后重试。' : name === 'NotFoundError' ? '没有找到麦克风，请连接设备后重试。' : '麦克风无法启动，请检查设备是否被其他程序占用。', `MICROPHONE_${name || 'ERROR'}`);
    this.patch({ microphone: 'error' });
  }
  private connect() {
    if (!this.runningWanted) return;
    this.disconnect();
    this.sessionId = crypto.randomUUID();
    const sessionId = this.sessionId;
    this.frameTimes = []; this.partialSeen.clear(); this.finalSeen.clear(); this.spokenFinalIds.clear(); this.localSpeechSeq = 0; this.firstCaptionAt.clear(); this.captionTimedIds.clear(); this.player.clear(true);
    const url = new URL('/api/ws', location.href); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url); this.socket = socket;
    this.connectionAt = Date.now();
    this.lastPong = Date.now();
    socket.onopen = () => { if (this.socket === socket) socket.send(JSON.stringify({ type: 'start', mode: this.state.mode, speechMode: this.state.speechMode, segmentation: this.state.segmentation, sessionId, token: this.token })); };
    socket.onmessage = event => {
      if (this.socket !== socket || !this.runningWanted) return;
      try {
        const message = JSON.parse(event.data) as ServerEvent;
        if ('sessionId' in message && message.sessionId !== this.sessionId) return;
        this.receive(message);
      } catch { this.fail('接收到无法处理的服务消息，请手动重试。', 'INVALID_RESPONSE'); }
    };
    socket.onclose = () => { if (this.socket === socket && this.runningWanted) this.reconnect('连接中断，正在重试；中断期间的内容不会补译。'); };
    socket.onerror = () => { /* 浏览器会随后触发 close，由统一恢复路径处理。 */ };
  }
  private receive(message: ServerEvent) {
    switch (message.type) {
      case 'ready':
        this.ready = true;
        this.startedAt = Date.now();
        if (this.recoveryAt) { sample(this.state.metrics.recoveryMs, Date.now() - this.recoveryAt); this.recoveryAt = 0; }
        this.patch({ phase: 'running', service: 'ok', message: this.state.mode === 'mock' ? '模拟课堂进行中：字幕为固定示例，语音由浏览器朗读，与实际讲话无关。' : this.state.segmentation === 'pause' ? '停顿送译实验进行中：停顿约 0.8 秒后自动收尾并接下一段，请关注断句和翻译完整性。' : this.state.speechMode === 'local' ? '正在采集中文。收到已确认的英文字幕后，由本机英语语音朗读。' : '正在采集中文。字幕与英文语音将陆续返回。', detail: '' });
        break;
      case 'pong': this.lastPong = Date.now(); this.state.metrics.rttMs = Date.now() - message.at; break;
      case 'recognition': this.patch({ draft: message.text }); break;
      case 'caption': {
        const id = `${this.sessionId}:${message.id}`;
        const receivedAt = performance.now();
        if (message.en.trim() && !this.captionTimedIds.has(id)) {
          if (!this.firstCaptionAt.has(id)) this.firstCaptionAt.set(id, receivedAt);
          if (message.final) {
            sample(this.state.metrics.captionConfirmationMs, receivedAt - this.firstCaptionAt.get(id)!);
            this.captionTimedIds.add(id); this.firstCaptionAt.delete(id);
          }
          if (this.firstCaptionAt.size > MAX_CAPTIONS * 2) this.firstCaptionAt.delete(this.firstCaptionAt.keys().next().value!);
          if (this.captionTimedIds.size > 1024) this.captionTimedIds.delete(this.captionTimedIds.values().next().value!);
        }
        this.patch({ captions: upsertCaption(this.state.captions, { id, zh: message.zh, en: message.en, final: message.final, at: Date.now() }), draft: '' });
        if (this.state.mode === 'live' && this.state.speechMode === 'local' && message.final && message.en.trim() && !this.spokenFinalIds.has(id)) {
          if (this.spokenFinalIds.size >= 1024) { this.reconnect('正在交接到新会话，交接期间可能缺少内容。', true); return; }
          this.spokenFinalIds.add(id);
          this.player.enqueue({ seq: this.localSpeechSeq++, text: message.en, localOnly: true, captionReceivedAt: receivedAt });
        }
        if (this.state.mode === 'live' && message.endMs > 0) {
          const frameAt = this.frameTimes[Math.max(0, Math.ceil(message.endMs / 40) - 1)];
          const seen = message.final ? this.finalSeen : this.partialSeen;
          if (frameAt && !seen.has(id)) {
            seen.add(id); sample(message.final ? this.state.metrics.finalLatencyMs : this.state.metrics.partialLatencyMs, performance.now() - frameAt);
          }
        }
        // 每次连接的文字标识也有界，长课堂按连接自然分段。
        if (this.partialSeen.size > MAX_CAPTIONS * 2) this.partialSeen.delete(this.partialSeen.values().next().value!);
        if (this.finalSeen.size > MAX_CAPTIONS * 2) this.finalSeen.delete(this.finalSeen.values().next().value!);
        break;
      }
      case 'audio': if (this.state.mode === 'live' && this.state.speechMode === 'provider') this.player.enqueue({ seq: message.seq, pcm: message.pcm, sampleRate: message.sampleRate }); break;
      case 'mock-speech': if (this.state.mode === 'mock') this.player.enqueue({ seq: message.seq, text: message.text }); break;
      case 'handoff': this.reconnect('正在交接到新会话，交接区间可能缺少内容；请重述关键句。', true); break;
      case 'error': if (message.retryable) this.reconnect(message.message); else this.fail(message.message, message.code); break;
    }
  }
  private sendFrame(frame: ArrayBuffer) {
    if (!this.runningWanted || !this.ready || this.socket?.readyState !== WebSocket.OPEN) return;
    if (this.socket.bufferedAmount > 64000) { this.reconnect('音频发送积压，正在重连。中断内容不会补译。'); return; }
    // 最大连接 250 秒；每帧只记录采集时间，不保存音频。
    if (this.frameTimes.length >= 6500) { this.reconnect('正在切换课堂会话，交接期间可能缺少内容。', true); return; }
    this.socket.send(frame); this.frameTimes.push(performance.now());
    if (this.state.mode === 'live') this.state.metrics.uploadedSeconds += frame.byteLength / 32000;
  }
  private reconnect(message: string, handoff = false) {
    if (!this.runningWanted) return;
    this.disconnect(); this.player.clear(true); this.state.metrics.interruptions++;
    this.recoveryAt ||= Date.now();
    if (!handoff && this.retries >= 5) { this.fail('多次重连失败，已停止采音。请检查网络后手动重试。', 'RETRY_EXHAUSTED'); return; }
    if (handoff) this.retries = 0;
    const delay = handoff ? 250 : Math.min(1000 * 2 ** this.retries++, 16000);
    this.state.metrics.reconnects++;
    this.patch({ phase: 'reconnecting', level: 0, draft: '', message, detail: `将在 ${(delay / 1000).toFixed(1)} 秒后重建会话。已有字幕保留。` });
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }
  private disconnect() {
    clearTimeout(this.retryTimer); this.ready = false; this.connectionAt = 0;
    const socket = this.socket; this.socket = undefined;
    if (socket) { socket.onopen = null; socket.onmessage = null; socket.onclose = null; socket.onerror = null; socket.close(); }
    this.sessionId = '';
  }
  private fail(message: string, detail: string) {
    this.stopResources(); this.patch({ phase: 'error', message, detail, level: 0, draft: '' });
  }
  private stopResources() {
    this.runningWanted = false; this.generation++; this.disconnect(); this.microphone.stop(); this.player.clear(true);
  }
  pause() { this.stopResources(); this.patch({ phase: 'paused', level: 0, draft: '', message: '已停止采音和播放。继续时建立新会话，暂停期间的内容不会补译。', detail: '' }); }
  end() { this.stopResources(); this.patch({ phase: 'ended', level: 0, draft: '', message: '课堂已结束，麦克风与连接已释放。当前字幕保留至刷新或关闭页面。', detail: '' }); }
  clearQueue() {
    this.player.clear(true);
    // 新建服务会话，使尚在合成中的旧片段也失效。
    if (this.runningWanted) this.reconnect('已清空待播内容，正在回到当前课堂；交接区间可能缺少内容。', true);
  }
  simulateDisconnect() { if (this.socket && this.runningWanted) this.reconnect('已主动模拟断连，正在验证自动恢复；中断内容不会补译。'); }
  openProjection() {
    if (!this.channel) { this.patch({ message: '浏览器不支持窗口同步，请更新 Edge / Chrome。' }); return; }
    this.projection = window.open(`/subtitles#${this.channelId}`, `classroom-${this.channelId}`, 'popup,width=1280,height=800');
    this.patch({ projectionOpen: !!this.projection, ...(!this.projection ? { message: '字幕窗口被拦截，请允许此网页弹出窗口后重试。' } : {}) });
  }
  private tick() {
    if (this.runningWanted) this.state.metrics.activeSeconds++;
    this.state.metrics.maxQueueSeconds = Math.max(this.state.metrics.maxQueueSeconds, this.player.seconds);
    if (this.runningWanted && this.ready && this.socket?.readyState === WebSocket.OPEN) {
      if (Date.now() - this.lastPong > 15000) this.reconnect('连接长时间没有响应，正在重试。');
      else this.socket.send(JSON.stringify({ type: 'ping', at: Date.now() }));
    }
    if (this.runningWanted && !this.ready && this.connectionAt && Date.now() - this.connectionAt > 12000) this.reconnect('课堂服务连接超时，正在重试。');
    if (this.runningWanted && Date.now() - this.levelAt > 10000) this.fail('麦克风长时间没有返回音频，请检查设备和浏览器后重试。', 'CAPTURE_STALLED');
    if (this.player.stalled) this.patch({ playbackError: '英文音频存在缺片，请清空待播或手动重试。' });
    if (this.startedAt && this.ready && Date.now() - this.startedAt > 30000) this.retries = 0;
    this.patch({ queueSeconds: this.player.seconds, playing: this.player.isPlaying, metrics: { ...this.state.metrics }, projectionOpen: !!this.projection && !this.projection.closed });
  }
  exportMetrics() {
    const { partialLatencyMs, finalLatencyMs, recoveryMs, audioQueueWaitMs, captionConfirmationMs, localSpeechStartMs, ...counters } = this.state.metrics;
    const report = {
      version: 'v0', mode: this.state.mode, speechMode: this.state.speechMode, segmentation: this.state.segmentation, createdAt: new Date().toISOString(),
      ...counters, partialSubtitleLatency: summarize(partialLatencyMs), finalSubtitleLatency: summarize(finalLatencyMs), recovery: summarize(recoveryMs), audioQueueWait: summarize(audioQueueWaitMs),
      captionConfirmation: summarize(captionConfirmationMs), localCaptionToSpeechStart: summarize(localSpeechStartMs),
      latestStageTimings: { captionConfirmationMs: captionConfirmationMs.at(-1) ?? null, localCaptionToSpeechStartMs: localSpeechStartMs.at(-1) ?? null },
      playbackLatency: '尚未完成输入片段与合成音频的可靠映射，需人工标记实测。',
      notes: ['不含音频、字幕或口令。', '字幕延迟基于浏览器收到音频帧时间近似计算，不能替代现场端到端测量。', '字幕确认时间从同片段首个英文文本到最终结果；若首个结果即最终则为零，不能据此认为云端处理无延迟。', '本机起播时间基于 speech synthesis 的 start 事件，包含本机排队等待，不代表扬声器实测发声时刻。', '两项最近值可能属于不同片段，不应直接相加为句尾延迟。', '模拟语音待播时长为估算，真实 PCM 待播时长由采样数计算。', '用量仅为已上传 PCM 时长估算，以供应商账单为准。'],
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `classroom-metrics-${Date.now()}.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.stopResources(); clearInterval(this.ticker);
    this.channel?.close(); this.channel = undefined;
    this.player.dispose(); this.listeners.clear();
  }
}
