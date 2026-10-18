import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const fakes = vi.hoisted(() => ({ stop: vi.fn(), capture: vi.fn(async () => {}), audioClear: vi.fn(), enqueue: vi.fn(), voice: vi.fn(async () => ({ lang: 'en-US', localService: true })) }));
vi.mock('../src/audio/capture', () => ({ Microphone: class { start = fakes.capture; stop = fakes.stop; } }));
vi.mock('../src/audio/local-voice', () => ({ waitForLocalEnglishVoice: fakes.voice }));
vi.mock('../src/audio/player', () => ({ AudioPlayer: class {
  constructor(private changed: () => void) {}
  seconds = 0; isPlaying = false; stalled = false;
  clear = fakes.audioClear; enqueue = fakes.enqueue;
  unlock = vi.fn(async () => {}); setVolume = vi.fn(); dispose = vi.fn(() => this.changed());
} }));
import { ClassroomController } from '../src/lib/controller';
class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 1; bufferedAmount = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  constructor() { FakeSocket.instances.push(this); }
  send(value: string) { this.sent.push(value); }
  close() { this.readyState = 3; }
  open() { this.onopen?.(); }
  event(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
}
let controller: ClassroomController;
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); FakeSocket.instances = [];
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
    // 返回采音电平心跳，隔离连接恢复逻辑。
    const onLevel = (fakes.capture.mock.calls[0] as unknown as [unknown, (level: number) => void])[1];
    for (let i = 0; i < 180 && controller.getSnapshot().phase !== 'error'; i++) { onLevel(0.1); await vi.advanceTimersByTimeAsync(1000); }
    expect(controller.getSnapshot().phase).toBe('error');
    expect(FakeSocket.instances.length).toBeLessThanOrEqual(6);
    expect(controller.getSnapshot().message).toContain('多次重连失败');
  });
  it('does not open a socket if stopped while microphone permission is pending', async () => {
    let resolveCapture!: () => void;
    fakes.capture.mockImplementationOnce(() => new Promise<void>(resolve => { resolveCapture = resolve; }));
    const starting = controller.start(); await Promise.resolve();
    controller.end(); resolveCapture(); await starting;
    expect(FakeSocket.instances).toHaveLength(0); expect(controller.getSnapshot().phase).toBe('ended');
  });
});
