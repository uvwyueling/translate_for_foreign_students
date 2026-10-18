import { findLocalEnglishVoice } from './local-voice';
export interface AudioItem { seq: number; pcm?: string; text?: string; sampleRate?: number; localOnly?: boolean; captionReceivedAt?: number }
export class OrderedInbox<T> {
  private pending = new Map<number, T>();
  private next = 0;
  accept(seq: number, item: T): T[] {
    if (seq < this.next || this.pending.has(seq)) return [];
    if (seq - this.next > 64 || this.pending.size >= 64) throw new Error('AUDIO_SEQUENCE_LIMIT');
    this.pending.set(seq, item);
    const ready: T[] = [];
    while (this.pending.has(this.next)) { ready.push(this.pending.get(this.next)!); this.pending.delete(this.next++); }
    return ready;
  }
  get size() { return this.pending.size; }
  clearPending() { this.pending.clear(); }
  reset() { this.next = 0; this.pending.clear(); }
}
/** 以音频时钟衔接 PCM，不依赖主线程 onended 回调启动下一块。 */
export class PcmScheduler {
  private sources = new Map<AudioBufferSourceNode, number>();
  private tail = 0;
  constructor(private context: AudioContext, private gain: GainNode, private changed: () => void) {}
  get seconds() { return Math.max(0, this.tail - this.context.currentTime); }
  schedule(buffer: AudioBuffer): number {
    const now = this.context.currentTime;
    // 页面忙时 onended 可能延后；已经播完的节点不占用新队列的容量。
    for (const [source, end] of this.sources) if (end <= now) { source.onended = null; source.disconnect(); this.sources.delete(source); }
    if (this.seconds + buffer.duration > 60 || this.sources.size >= 512) throw new Error('AUDIO_QUEUE_LIMIT');
    const source = this.context.createBufferSource(); source.buffer = buffer; source.connect(this.gain);
    const start = Math.max(now, this.tail);
    this.tail = start + buffer.duration;
    this.sources.set(source, this.tail);
    source.onended = () => { if (this.sources.delete(source)) { source.disconnect(); this.changed(); } };
    source.start(start);
    return start - now;
  }
  clear() {
    for (const source of this.sources.keys()) { source.onended = null; source.stop(); source.disconnect(); }
    this.sources.clear(); this.tail = 0;
  }
}
export class AudioPlayer {
  private context?: AudioContext;
  private gain?: GainNode;
  private inbox = new OrderedInbox<AudioItem>();
  private queue: { item: AudioItem; seconds: number }[] = [];
  private pcm?: PcmScheduler;
  private utterance?: SpeechSynthesisUtterance;
  private currentSeconds = 0;
  private currentAt = 0;
  private generation = 0;
  private volume = 0.8;
  private minSequence = 0;
  private highestSequence = -1;
  private lastProgress = Date.now();
  constructor(private changed: () => void, private failed: (message: string) => void, private scheduled?: (waitMs: number) => void, private speechStarted?: (captionWaitMs: number) => void) {}
  async unlock() {
    this.context ??= new AudioContext({ latencyHint: 'interactive' });
    if (!this.gain) { this.gain = this.context.createGain(); this.gain.connect(this.context.destination); }
    this.gain.gain.value = this.volume;
    this.pcm ??= new PcmScheduler(this.context, this.gain, this.changed);
    await this.context.resume();
    // 由教师点击直接触发浏览器语音权限解锁。
    if ('speechSynthesis' in window) { const u = new SpeechSynthesisUtterance(''); speechSynthesis.speak(u); }
  }
  setVolume(value: number) {
    this.volume = value;
    if (this.gain) this.gain.gain.value = value;
    if (this.utterance) this.utterance.volume = value;
  }
  get seconds() { return (this.pcm?.seconds ?? 0) + this.queue.reduce((sum, x) => sum + x.seconds, 0) + Math.max(0, this.currentSeconds - (this.currentAt ? (Date.now() - this.currentAt) / 1000 : 0)); }
  get isPlaying() { return (this.pcm?.seconds ?? 0) > 0 || (!!this.utterance && this.currentAt > 0); }
  get stalled() { return this.inbox.size > 0 && Date.now() - this.lastProgress > 12000; }
  enqueue(item: AudioItem) {
    if (item.seq < this.minSequence) return;
    this.highestSequence = Math.max(item.seq, this.highestSequence);
    try {
      const ready = this.inbox.accept(item.seq, item);
      if (ready.length) this.lastProgress = Date.now();
      for (const next of ready) {
        if (next.pcm) { this.schedulePcm(next); continue; }
        const seconds = (next.text?.split(/\s+/).length ?? 0) / 2.5;
        if (this.seconds + seconds > 60 || this.queue.length >= 60) {
          this.failed('英文待播已达到 60 秒上限。已停止采音，请清空待播内容后重试。'); return;
        }
        this.queue.push({ item: next, seconds });
      }
      this.playNext(); this.changed();
    } catch (error) {
      this.failed(error instanceof Error && error.message === 'AUDIO_QUEUE_LIMIT' ? '英文待播已达到 60 秒上限。已停止采音，请清空待播内容后重试。' : '英文音频格式或顺序异常，请手动重试；已有字幕仍可查看。');
    }
  }
  private schedulePcm(item: AudioItem) {
    if (!this.context || !this.gain || !this.pcm || this.context.state !== 'running') {
      this.failed('英文播放被浏览器暂停，请点击“恢复播放”后重试。'); return;
    }
    const binary = atob(item.pcm!), bytes = new Uint8Array(binary.length);
    if (bytes.length % 2 !== 0) throw new Error('INVALID_PCM');
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const view = new DataView(bytes.buffer);
    const buffer = this.context.createBuffer(1, bytes.length / 2, item.sampleRate ?? 16000);
    const output = buffer.getChannelData(0);
    for (let i = 0; i < output.length; i++) output[i] = view.getInt16(i * 2, true) / 32768;
    const waitMs = this.pcm.schedule(buffer) * 1000;
    this.scheduled?.(waitMs);
  }
  private playNext() {
    if (this.utterance || (this.pcm?.seconds ?? 0) > 0 || !this.queue.length) return;
    const next = this.queue.shift()!;
    const generation = this.generation;
    this.currentSeconds = next.seconds; this.currentAt = 0;
    const complete = () => {
      if (generation !== this.generation) return;
      this.utterance = undefined; this.currentSeconds = 0; this.currentAt = 0;
      this.changed(); this.playNext();
    };
    if (next.item.text && 'speechSynthesis' in window) {
      const u = new SpeechSynthesisUtterance(next.item.text); u.lang = 'en-US'; u.volume = this.volume; u.rate = 1;
      const voice = findLocalEnglishVoice();
      if (next.item.localOnly && !voice) { this.currentSeconds = 0; this.failed('未找到本机英语语音，请安装英语语音包或切回讯飞语音。字幕仍会继续显示。'); return; }
      if (voice) u.voice = voice;
      this.utterance = u; u.onend = complete;
      u.onstart = () => {
        if (generation !== this.generation) return;
        this.currentAt = Date.now();
        if (next.item.captionReceivedAt !== undefined) this.speechStarted?.(performance.now() - next.item.captionReceivedAt);
        this.changed();
      };
      u.onerror = () => { if (generation === this.generation) { complete(); this.failed('英文试听或模拟语音播放失败，请检查浏览器英语语音与电脑输出。'); } };
      speechSynthesis.speak(u);
    } else { complete(); this.failed('当前浏览器无法播放英文测试语音，请检查英语语音包。'); }
  }
  clear(reset = false) {
    this.generation++;
    this.pcm?.clear();
    if (this.utterance) { this.utterance.onstart = null; this.utterance.onend = null; this.utterance.onerror = null; speechSynthesis.cancel(); }
    this.utterance = undefined; this.queue = []; this.currentSeconds = 0; this.currentAt = 0;
    // 已跳过的片段不再接受；课堂层清空通过新会话同时阻断尚未返回的旧音频。
    this.minSequence = reset ? 0 : this.highestSequence + 1;
    if (reset) { this.inbox.reset(); this.highestSequence = -1; }
    else this.inbox.clearPending();
    this.changed();
  }
  async test(localOnly = false) {
    await this.unlock(); this.clear(true);
    this.enqueue({ seq: 0, text: 'Hello. This is the classroom audio test. Please check your headphones.', localOnly });
  }
  dispose() { this.clear(true); void this.context?.close(); this.context = undefined; this.gain = undefined; this.pcm = undefined; }
}
