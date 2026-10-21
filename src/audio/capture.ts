import processorUrl from './capture.worklet.ts?worker&url';

export interface CaptureDiagnostics {
  stage: 'idle' | 'resuming' | 'permission' | 'worklet' | 'capturing' | 'stopped';
  stageAt: number;
  contextState: string;
  sampleRate: number | null;
  trackState: string;
  trackMuted: boolean;
  trackEnabled: boolean;
  workletReady: boolean;
  renderCallbacks: number;
  inputCallbacks: number;
  frames: number;
}
export const emptyCaptureDiagnostics = (): CaptureDiagnostics => ({
  stage: 'idle', stageAt: 0, contextState: 'unavailable', sampleRate: null, trackState: 'unavailable',
  trackMuted: false, trackEnabled: false, workletReady: false, renderCallbacks: 0, inputCallbacks: 0, frames: 0,
});
export type CaptureFailure = 'CAPTURE_PROCESSOR_ERROR' | 'CAPTURE_CONTEXT_INTERRUPTED' | 'CAPTURE_TRACK_ENDED';

export class Microphone {
  private stream?: MediaStream;
  private context?: AudioContext;
  private node?: AudioWorkletNode;
  private source?: MediaStreamAudioSourceNode;
  private silence?: GainNode;
  private preparation?: Promise<void>;
  private starting = false;
  private stats = emptyCaptureDiagnostics();
  private generation = 0;

  get diagnostics(): CaptureDiagnostics {
    const track = this.stream?.getAudioTracks()[0];
    return { ...this.stats, contextState: this.context?.state ?? 'unavailable', sampleRate: this.context?.sampleRate ?? null,
      trackState: track?.readyState ?? 'unavailable', trackMuted: track?.muted ?? false, trackEnabled: track?.enabled ?? false };
  }
  private stage(stage: CaptureDiagnostics['stage']) { this.stats.stage = stage; this.stats.stageAt = Date.now(); }

  // 在点击事件的同步调用栈内启动音频，避免等授权/播放后才创建 Safari 的采音上下文。
  prepare(): Promise<void> {
    if (!this.context) {
      this.stats = emptyCaptureDiagnostics(); this.stage('resuming');
      this.context = new AudioContext();
      this.preparation = this.context.resume();
    }
    return this.preparation!;
  }

  async start(onFrame: (frame: ArrayBuffer) => void, onLevel: (value: number) => void, onFailure: (code: CaptureFailure) => void) {
    if (this.stream || this.node || this.starting) this.stop();
    const preparation = this.prepare();
    // 授权等待期间也处理 resume 的拒绝，稍后再统一传播。
    const resumed = preparation.then(() => ({ ok: true as const }), error => ({ ok: false as const, error }));
    const context = this.context!;
    const generation = this.generation;
    this.starting = true; this.stage('permission');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      if (generation !== this.generation) { stream.getTracks().forEach(t => t.stop()); return; }
      this.stream = stream; this.stage('resuming');
      const result = await resumed;
      if (generation !== this.generation) return;
      if (!result.ok) throw result.error;
      this.stage('worklet');
      await context.audioWorklet.addModule(processorUrl);
      if (generation !== this.generation) return;
      const source = context.createMediaStreamSource(stream); this.source = source;
      const node = new AudioWorkletNode(context, 'classroom-capture'); this.node = node;
      const silence = context.createGain(); this.silence = silence; silence.gain.value = 0;
      node.port.onmessage = event => {
        if (generation !== this.generation) return;
        if (event.data.type === 'pcm') { this.stats.frames++; onFrame(event.data.buffer); }
        else if (event.data.type === 'level') onLevel(event.data.level);
        else if (event.data.type === 'ready') this.stats.workletReady = true;
        else if (event.data.type === 'heartbeat') {
          this.stats.renderCallbacks = event.data.renderCallbacks; this.stats.inputCallbacks = event.data.inputCallbacks;
        }
      };
      node.onprocessorerror = () => { if (generation === this.generation) onFailure('CAPTURE_PROCESSOR_ERROR'); };
      stream.getTracks().forEach(t => t.addEventListener('ended', () => { if (generation === this.generation) onFailure('CAPTURE_TRACK_ENDED'); }));
      context.onstatechange = () => { if (generation === this.generation && context.state !== 'running') onFailure('CAPTURE_CONTEXT_INTERRUPTED'); };
      source.connect(node).connect(silence).connect(context.destination);
      this.stage('capturing');
    } catch (error) { if (generation === this.generation) this.stop(); throw error; }
    finally { if (generation === this.generation) this.starting = false; }
  }
  stop() {
    this.generation++;
    if (this.node) { this.node.port.onmessage = null; this.node.onprocessorerror = null; this.node.port.close(); this.node.disconnect(); }
    this.node = undefined;
    this.source?.disconnect(); this.source = undefined;
    this.silence?.disconnect(); this.silence = undefined;
    this.stream?.getTracks().forEach(t => t.stop()); this.stream = undefined;
    if (this.context) { this.context.onstatechange = null; void this.context.close().catch(() => {}); }
    this.context = undefined; this.preparation = undefined; this.starting = false; this.stage('stopped');
  }
}
