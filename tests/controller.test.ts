import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const fakes = vi.hoisted(() => ({ diagnostics: vi.fn(), prepare: vi.fn(async () => {}), unlock: vi.fn(async () => {}), stop: vi.fn(), capture: vi.fn(async () => {}), audioClear: vi.fn(), enqueue: vi.fn(), voice: vi.fn(async () => ({ lang: 'en-US', localService: true })) }));
vi.mock('../src/audio/capture', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/audio/capture')>();
  return { ...actual, Microphone: class { start = fakes.capture; stop = fakes.stop; prepare = fakes.prepare; get diagnostics() { return fakes.diagnostics() ?? actual.emptyCaptureDiagnostics(); } } };
});
vi.mock('../src/audio/local-voice', () => ({ waitForLocalEnglishVoice: fakes.voice }));
vi.mock('../src/audio/player', () => ({ AudioPlayer: class {
  constructor(private changed: () => void) {}
  seconds = 0; isPlaying = false; stalled = false;
  clear = fakes.audioClear; enqueue = fakes.enqueue;
  unlock = fakes.unlock; setVolume = vi.fn(); dispose = vi.fn(() => this.changed());
} }));
import { ClassroomController } from '../src/lib/controller';
class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0; bufferedAmount = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  frames: ArrayBuffer[] = [];
  constructor() { FakeSocket.instances.push(this); }
  send(value: string | ArrayBuffer) { if (typeof value === 'string') this.sent.push(value); else this.frames.push(value); }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(); }
  event(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
}
let controller: ClassroomController;
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); fakes.diagnostics.mockReturnValue(undefined); FakeSocket.instances = [];
  vi.stubGlobal('window', { isSecureContext: true, AudioContext: class {}, AudioWorkletNode: class {}, WebSocket: FakeSocket });
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn() } });
  vi.stubGlobal('location', { href: 'http://localhost/', protocol: 'http:' });
  vi.stubGlobal('WebSocket', FakeSocket);
  controller = new ClassroomController();
});
afterEach(() => { controller.dispose(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const last = () => FakeSocket.instances.at(-1)!;
function ready() {
  const socket = last(); socket.open();
  const start = JSON.parse(socket.sent[0]); socket.event({ type: 'ready', sessionId: start.sessionId, mode: 'mock' });
  return { socket, sessionId: start.sessionId };
}
describe('classroom lifecycle', () => {
  it('measures backend reachability before provider ready without sending buffered audio', async () => {
    await controller.start();
    expect(controller.getSnapshot().connectionStage).toBe('browser-connecting');
    const socket = last(); socket.open();
    expect(controller.getSnapshot().connectionStage).toBe('waiting-backend');
    const sessionId = JSON.parse(socket.sent[0]).sessionId;
    socket.event({ type: 'connecting', sessionId });
    expect(controller.getSnapshot().connectionStage).toBe('provider-connecting');
    const onFrame = (fakes.capture.mock.calls[0] as unknown as [(frame: ArrayBuffer) => void])[0];
    onFrame(new ArrayBuffer(1280)); await vi.advanceTimersByTimeAsync(1000);
    const ping = JSON.parse(socket.sent.at(-1)!);
    expect(ping.type).toBe('ping');
    await vi.advanceTimersByTimeAsync(100); socket.event({ type: 'pong', at: ping.at });
    expect(controller.getSnapshot().metrics.rttMs).toBe(100);
    expect(controller.getSnapshot().phase).toBe('connecting'); expect(socket.frames).toHaveLength(0);
    socket.event({ type: 'ready', sessionId, mode: 'mock' });
    expect(controller.getSnapshot()).toMatchObject({ phase: 'running', connectionStage: 'ready', connectionWaitMs: 1100 });
    expect(socket.frames).toHaveLength(1);
  });
  it.each(['browser-connecting', 'waiting-backend', 'provider-connecting'] as const)('retains %s when the startup buffer fills', async stage => {
    await controller.start(); const socket = last();
    if (stage !== 'browser-connecting') socket.open();
    if (stage === 'provider-connecting') socket.event({ type: 'connecting', sessionId: JSON.parse(socket.sent[0]).sessionId });
    const onFrame = (fakes.capture.mock.calls[0] as unknown as [(frame: ArrayBuffer) => void])[0];
    await vi.advanceTimersByTimeAsync(1000);
    for (let i = 0; i < 301; i++) onFrame(new ArrayBuffer(1280));
    await vi.advanceTimersByTimeAsync(2000);
    expect(controller.getSnapshot()).toMatchObject({ phase: 'error', detail: 'STARTUP_AUDIO_LIMIT', connectionStage: stage, connectionWaitMs: 1000, pendingFrames: 300, sentFrames: 0 });
    expect(socket.frames).toHaveLength(0);
  });
  it('ignores provider startup acknowledgements from old sessions or after ready', async () => {
    await controller.start(); const { socket, sessionId } = ready();
    socket.event({ type: 'connecting', sessionId: 'stale-session' });
    socket.event({ type: 'connecting', sessionId });
    expect(controller.getSnapshot().connectionStage).toBe('ready');
  });
  it('does not count idle time or a pending microphone permission as stalled capture', async () => {
    await vi.advanceTimersByTimeAsync(20000);
    let resolveCapture!: () => void;
    fakes.capture.mockImplementationOnce(() => new Promise<void>(resolve => { resolveCapture = resolve; }));
    const starting = controller.start(); await Promise.resolve();
    await vi.advanceTimersByTimeAsync(15000);
    expect(controller.getSnapshot().phase).toBe('connecting');
    resolveCapture(); await starting;
    expect(FakeSocket.instances).toHaveLength(1);
  });
  it('uses arriving PCM frames as capture progress even when level events stop', async () => {
    await controller.start(); ready();
    const onFrame = (fakes.capture.mock.calls[0] as unknown as [(frame: ArrayBuffer) => void])[0];
    for (let i = 0; i < 12; i++) { onFrame(new ArrayBuffer(1280)); await vi.advanceTimersByTimeAsync(1000); }
    expect(controller.getSnapshot().phase).toBe('running');
    expect(last().frames).toHaveLength(12);
  });
  it('prepares capture in the click handler before waiting for playback unlock', async () => {
    let resolveUnlock!: () => void;
    fakes.unlock.mockImplementationOnce(() => new Promise<void>(resolve => { resolveUnlock = resolve; }));
    const starting = controller.start();
    expect(fakes.prepare).toHaveBeenCalledTimes(1);
    expect(fakes.capture).not.toHaveBeenCalled();
    resolveUnlock(); await starting;
    expect(fakes.capture).toHaveBeenCalledTimes(1);
  });
  it('reports blocked audio startup separately from stalled capture', async () => {
    let resolveUnlock!: () => void;
    fakes.unlock.mockImplementationOnce(() => new Promise<void>(resolve => { resolveUnlock = resolve; }));
    const starting = controller.start();
    await vi.advanceTimersByTimeAsync(11000);
    expect(controller.getSnapshot()).toMatchObject({ phase: 'error', detail: 'AUDIO_START_TIMEOUT' });
    resolveUnlock(); await starting;
    expect(FakeSocket.instances).toHaveLength(0);
  });
  it('detects missing PCM frames even if the volume meter still updates', async () => {
    await controller.start(); ready();
    const onLevel = (fakes.capture.mock.calls[0] as unknown as [unknown, (level: number) => void])[1];
    for (let i = 0; i < 11; i++) { onLevel(0.1); await vi.advanceTimersByTimeAsync(1000); }
    expect(controller.getSnapshot()).toMatchObject({ phase: 'error', detail: 'CAPTURE_STALLED' });
  });
  it('surfaces processor failures immediately and ignores stale failures after pause', async () => {
    await controller.start(); ready();
    const onFailure = (fakes.capture.mock.calls[0] as unknown as [unknown, unknown, (code: string) => void])[2];
    onFailure('CAPTURE_PROCESSOR_ERROR');
    expect(controller.getSnapshot()).toMatchObject({ phase: 'error', detail: 'CAPTURE_PROCESSOR_ERROR' });
    controller.pause(); onFailure('CAPTURE_TRACK_ENDED');
    expect(controller.getSnapshot().phase).toBe('paused');
  });
  it('preserves the last capture snapshot after cleanup and later watchdog ticks', async () => {
    await controller.start(); ready();
    const snapshot = { ...controller.getSnapshot().capture, stage: 'capturing' as const, contextState: 'interrupted', frames: 42, workletReady: true };
    fakes.diagnostics.mockReturnValue(snapshot);
    fakes.stop.mockImplementationOnce(() => fakes.diagnostics.mockReturnValue(undefined));
    const onFailure = (fakes.capture.mock.calls[0] as unknown as [unknown, unknown, (code: string) => void])[2];
    onFailure('CAPTURE_CONTEXT_INTERRUPTED');
    await vi.advanceTimersByTimeAsync(2000);
    expect(controller.getSnapshot().capture).toEqual(snapshot);
    expect(controller.getSnapshot().detail).toBe('CAPTURE_CONTEXT_INTERRUPTED');
  });
  it('keeps the server failure code available while reconnecting', async () => {
    await controller.start(); const { socket } = ready();
    socket.event({ type: 'error', code: 'UPSTREAM_BACKPRESSURE', message: '网络发送积压', retryable: true });
    expect(controller.getSnapshot().phase).toBe('reconnecting');
    expect(controller.getSnapshot().detail).toContain('UPSTREAM_BACKPRESSURE');
  });
  it('preserves speech captured before ready and sends it in order at real-time pace', async () => {
    controller.setMode('live'); await controller.start();
    const onFrame = (fakes.capture.mock.calls[0] as unknown as [(frame: ArrayBuffer) => void])[0];
    const frames = Array.from({ length: 4 }, (_, i) => new Uint8Array(1280).fill(i + 1).buffer);
    onFrame(frames[0]); await vi.advanceTimersByTimeAsync(40); onFrame(frames[1]);
    expect(last().frames).toHaveLength(0);
    const { socket } = ready();
    expect(socket.frames).toEqual([frames[0]]);
    // 新采到的音频必须排在连接前的音频后面，不能越过尚未发送的句首。
    onFrame(frames[2]); await vi.advanceTimersByTimeAsync(39);
    expect(socket.frames).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1); onFrame(frames[3]);
    await vi.advanceTimersByTimeAsync(80);
    expect(socket.frames).toEqual(frames);
    expect(controller.getSnapshot().metrics.uploadedSeconds).toBeCloseTo(0.16);
    controller.pause(); await vi.advanceTimersByTimeAsync(1000);
    expect(socket.frames).toEqual(frames);
  });
  it('discards startup audio on pause and never replays it into a resumed class', async () => {
    await controller.start();
    const firstCapture = (fakes.capture.mock.calls[0] as unknown as [(frame: ArrayBuffer) => void])[0];
    firstCapture(new Uint8Array(1280).fill(1).buffer);
    controller.pause(); await controller.start();
    const { socket } = ready(); await vi.advanceTimersByTimeAsync(80);
    expect(socket.frames).toHaveLength(0);
    const nextCapture = (fakes.capture.mock.calls[1] as unknown as [(frame: ArrayBuffer) => void])[0];
    const fresh = new Uint8Array(1280).fill(2).buffer; nextCapture(fresh);
    expect(socket.frames).toEqual([fresh]);
    firstCapture(new Uint8Array(1280).fill(3).buffer);
    expect(socket.frames).toEqual([fresh]);
  });
  it('keeps reconnect gaps separate from startup buffering', async () => {
    await controller.start(); const first = ready();
    const onFrame = (fakes.capture.mock.calls[0] as unknown as [(frame: ArrayBuffer) => void])[0];
    const old = new Uint8Array(1280).fill(1).buffer;
    onFrame(old); expect(first.socket.frames).toEqual([old]);
    controller.simulateDisconnect(); onFrame(new Uint8Array(1280).fill(2).buffer);
    await vi.advanceTimersByTimeAsync(1000);
    onFrame(new Uint8Array(1280).fill(3).buffer);
    const second = ready(); await vi.advanceTimersByTimeAsync(80);
    expect(second.socket.frames).toHaveLength(0);
    const fresh = new Uint8Array(1280).fill(4).buffer; onFrame(fresh);
    expect(second.socket.frames).toEqual([fresh]);
  });
  it('stops with a clear error instead of silently truncating a full startup buffer', async () => {
    await controller.start();
    const onFrame = (fakes.capture.mock.calls[0] as unknown as [(frame: ArrayBuffer) => void])[0];
    for (let i = 0; i < 301; i++) onFrame(new ArrayBuffer(1280));
    expect(controller.getSnapshot()).toMatchObject({ phase: 'error', detail: 'STARTUP_AUDIO_LIMIT' });
    expect(fakes.stop).toHaveBeenCalled(); expect(last().frames).toHaveLength(0);
  });
  it('sends selected segmentation to the server and prevents changing it while capturing', async () => {
    expect(controller.getSnapshot().segmentation).toBe('continuous');
    controller.setMode('live'); controller.setSegmentation('pause'); await controller.start(); last().open();
    expect(JSON.parse(last().sent[0]).segmentation).toBe('pause');
    controller.setSegmentation('continuous'); expect(controller.getSnapshot().segmentation).toBe('pause');
    controller.pause(); controller.setSegmentation('continuous'); expect(controller.getSnapshot().segmentation).toBe('continuous');
  });
  it('speaks each final caption once in local mode and never mixes cloud audio or mock results', async () => {
    controller.setMode('live'); controller.setSpeechMode('local'); await controller.start();
    const { socket, sessionId } = ready();
    const caption = { type: 'caption', sessionId, id: 'a', zh: '课堂测试', en: 'Classroom test.', final: false, endMs: 0 };
    socket.event(caption); expect(fakes.enqueue).not.toHaveBeenCalled();
    socket.event({ ...caption, final: true }); socket.event({ ...caption, final: true });
    socket.event({ type: 'audio', sessionId, seq: 0, pcm: 'AAA=', sampleRate: 16000 });
    socket.event({ type: 'mock-speech', sessionId, seq: 0, text: 'must not play' });
    expect(fakes.enqueue).toHaveBeenCalledTimes(1);
    expect(fakes.enqueue).toHaveBeenLastCalledWith({ seq: 0, text: 'Classroom test.', localOnly: true, captionReceivedAt: expect.any(Number) });
    controller.setSpeechMode('provider'); expect(controller.getSnapshot().speechMode).toBe('local');
    controller.pause(); await controller.start(); const next = ready();
    next.socket.event({ ...caption, sessionId: next.sessionId, final: true });
    expect(fakes.enqueue).toHaveBeenCalledTimes(2);
    expect(fakes.enqueue).toHaveBeenLastCalledWith({ seq: 0, text: 'Classroom test.', localOnly: true, captionReceivedAt: expect.any(Number) });
  });
  it('keeps original cloud audio as default without also reading captions', async () => {
    controller.setMode('live'); await controller.start(); const { socket, sessionId } = ready();
    socket.event({ type: 'caption', sessionId, id: 'a', zh: '测试', en: 'Test.', final: true, endMs: 0 });
    expect(fakes.enqueue).not.toHaveBeenCalled();
    socket.event({ type: 'audio', sessionId, seq: 0, pcm: 'AAA=', sampleRate: 16000 });
    expect(fakes.enqueue).toHaveBeenCalledTimes(1);
    expect(fakes.voice).not.toHaveBeenCalled();
  });
  it('times caption confirmation per segment without counting repeated finals twice', async () => {
    controller.setMode('live'); await controller.start(); const { socket, sessionId } = ready();
    const caption = { type: 'caption', sessionId, id: 'timed', zh: '测试', en: 'Test', final: false, endMs: 0 };
    socket.event(caption); await vi.advanceTimersByTimeAsync(1200);
    socket.event({ ...caption, final: true }); socket.event({ ...caption, final: true });
    expect(controller.getSnapshot().metrics.captionConfirmationMs).toEqual([1200]);
    socket.event({ ...caption, id: 'already-final', final: true });
    expect(controller.getSnapshot().metrics.captionConfirmationMs).toEqual([1200, 0]);
  });
  it('does not start capture or cloud requests when no local English voice is available', async () => {
    fakes.voice.mockResolvedValueOnce(undefined as unknown as { lang: string; localService: boolean });
    controller.setMode('live'); controller.setSpeechMode('local'); await controller.start();
    expect(controller.getSnapshot().phase).toBe('error');
    expect(controller.getSnapshot().detail).toBe('LOCAL_VOICE_UNAVAILABLE');
    expect(fakes.capture).not.toHaveBeenCalled(); expect(FakeSocket.instances).toHaveLength(0);
  });
  it('can dispose twice without broadcasting to an already closed channel', () => {
    const close = vi.fn();
    vi.stubGlobal('window', { BroadcastChannel: true });
    vi.stubGlobal('BroadcastChannel', class {
      closed = false; onmessage = null;
      postMessage() { if (this.closed) throw new Error('Channel closed'); }
      close() { this.closed = true; close(); }
    });
    const extra = new ClassroomController();
    expect(() => { extra.dispose(); extra.dispose(); }).not.toThrow();
    expect(close).toHaveBeenCalledTimes(1);
  });
  it('releases capture and ignores late captions/audio after pause and end', async () => {
    await controller.start(); const { socket, sessionId } = ready();
    const lateHandler = socket.onmessage!;
    controller.pause();
    lateHandler({ data: JSON.stringify({ type: 'mock-speech', sessionId, seq: 0, text: 'late' }) });
    expect(fakes.enqueue).not.toHaveBeenCalled(); expect(fakes.stop).toHaveBeenCalled(); expect(controller.getSnapshot().phase).toBe('paused');
    await controller.start(); const next = ready(); expect(next.sessionId).not.toBe(sessionId);
    controller.end(); expect(controller.getSnapshot().phase).toBe('ended'); expect(next.socket.readyState).toBe(3);
  });
  it('uses a new session on clear and rejects old-session events on a new socket', async () => {
    await controller.start(); const first = ready();
    controller.clearQueue(); expect(controller.getSnapshot().phase).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(250); const second = ready();
    second.socket.event({ type: 'caption', sessionId: first.sessionId, id: 'old', zh: '旧', en: 'old', final: true, endMs: 0 });
    expect(controller.getSnapshot().captions).toHaveLength(0);
    second.socket.event({ type: 'caption', sessionId: second.sessionId, id: 'new', zh: '新', en: 'new', final: true, endMs: 0 });
    expect(controller.getSnapshot().captions).toHaveLength(1);
  });
  it('stops retrying permanent account errors and does not claim to translate', async () => {
    await controller.start(); ready();
    last().event({ type: 'error', code: 'XFYUN_11200', message: '服务额度不足', retryable: false });
    await vi.advanceTimersByTimeAsync(30000);
    expect(controller.getSnapshot().phase).toBe('error'); expect(FakeSocket.instances).toHaveLength(1);
  });
  it('times out a half-open connection and bounds consecutive reconnects', async () => {
    await controller.start();
    // 返回实际采音帧心跳，隔离连接恢复逻辑。
    const onFrame = (fakes.capture.mock.calls[0] as unknown as [(frame: ArrayBuffer) => void])[0];
    for (let i = 0; i < 180 && controller.getSnapshot().phase !== 'error'; i++) { onFrame(new ArrayBuffer(1280)); await vi.advanceTimersByTimeAsync(1000); }
    expect(controller.getSnapshot().phase).toBe('error');
    expect(FakeSocket.instances.length).toBeLessThanOrEqual(6);
    expect(controller.getSnapshot().message).toContain('多次重连失败');
  });
  it('does not open a socket if stopped while microphone permission is pending', async () => {
    let resolveCapture!: () => void;
    fakes.capture.mockImplementationOnce(() => new Promise<void>(resolve => { resolveCapture = resolve; }));
    const starting = controller.start(); await vi.advanceTimersByTimeAsync(0);
    controller.end(); resolveCapture(); await starting;
    expect(FakeSocket.instances).toHaveLength(0); expect(controller.getSnapshot().phase).toBe('ended');
  });
});
