import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioPlayer, PcmScheduler } from '../src/audio/player';
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function fixture() {
  const nodes: { onended: (() => void) | null; buffer: unknown; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; connect: ReturnType<typeof vi.fn> }[] = [];
  const context = { currentTime: 5, createBufferSource: () => {
    const node = { onended: null, buffer: null, start: vi.fn(), stop: vi.fn(), disconnect: vi.fn(), connect: vi.fn() }; nodes.push(node); return node;
  } };
  const changed = vi.fn();
  return { context, nodes, changed, scheduler: new PcmScheduler(context as unknown as AudioContext, {} as GainNode, changed) };
}
const buffer = (duration: number) => ({ duration }) as AudioBuffer;
describe('continuous PCM playback', () => {
  it('measures actual speech start instead of enqueue time and retains pending duration', async () => {
    vi.useFakeTimers();
    const context = { resume: async () => {}, close: async () => {}, currentTime: 0, destination: {}, createGain: () => ({ gain: { value: 1 }, connect: vi.fn() }) };
    class Utterance {
      onstart: (() => void) | null = null; onend: (() => void) | null = null; onerror: (() => void) | null = null;
      constructor(public text: string) {}
    }
    const utterances: Utterance[] = [];
    const speech = { getVoices: () => [{ lang: 'en-US', localService: true }], speak: (u: Utterance) => utterances.push(u), cancel: vi.fn() };
    vi.stubGlobal('window', { speechSynthesis: speech }); vi.stubGlobal('speechSynthesis', speech);
    vi.stubGlobal('SpeechSynthesisUtterance', Utterance); vi.stubGlobal('AudioContext', class { constructor() { return context; } });
    const started = vi.fn(), player = new AudioPlayer(vi.fn(), vi.fn(), undefined, started);
    await player.unlock();
    player.enqueue({ seq: 0, text: 'This is the first test.', localOnly: true, captionReceivedAt: performance.now() });
    const pendingSeconds = player.seconds;
    await vi.advanceTimersByTimeAsync(2000);
    expect(player.seconds).toBe(pendingSeconds); expect(player.isPlaying).toBe(false); expect(started).not.toHaveBeenCalled();
    // 两秒只是测试所设置的浏览器等待，并不声称真实环境需要两秒。
    const first = utterances.find(u => !!u.text)!; first.onstart?.();
    expect(started).toHaveBeenCalledWith(2000); expect(player.isPlaying).toBe(true);
    const lateStart = first.onstart!; player.clear(true); lateStart(); expect(started).toHaveBeenCalledTimes(1);
    expect(first.onstart).toBeNull(); expect(player.seconds).toBe(0); player.dispose();
  });
  it('plays ordered PCM without an optional diagnostics observer and clears scheduled sound', async () => {
    const { context, nodes } = fixture();
    const audioContext = {
      ...context, state: 'running', destination: {}, resume: async () => {}, close: async () => {},
      createGain: () => ({ gain: { value: 1 }, connect: vi.fn() }),
      createBuffer: (_channels: number, length: number, rate: number) => ({ duration: length / rate, getChannelData: () => new Float32Array(length) }),
    };
    vi.stubGlobal('AudioContext', class { constructor() { return audioContext; } });
    vi.stubGlobal('window', {});
    const failed = vi.fn(), player = new AudioPlayer(vi.fn(), failed);
    await player.unlock();
    const pcm = Buffer.alloc(3200).toString('base64');
    player.enqueue({ seq: 1, pcm, sampleRate: 16000 }); expect(nodes).toHaveLength(0);
    player.enqueue({ seq: 0, pcm, sampleRate: 16000 }); expect(nodes).toHaveLength(2);
    expect(player.seconds).toBeCloseTo(0.2); expect(failed).not.toHaveBeenCalled();
    player.clear(true); expect(nodes.every(node => node.stop.mock.calls.length === 1)).toBe(true);
    expect(player.seconds).toBe(0); player.dispose();
  });
  it('schedules contiguous audio without waiting for delayed main-thread end callbacks', () => {
    const { scheduler, nodes, context } = fixture();
    expect(scheduler.schedule(buffer(0.2))).toBe(0);
    context.currentTime = 5.05;
    expect(scheduler.schedule(buffer(0.3))).toBeCloseTo(0.15);
    context.currentTime = 5.1; scheduler.schedule(buffer(0.1));
    expect(nodes.map(node => node.start.mock.calls[0][0])).toEqual([5, 5.2, 5.5]);
    expect(scheduler.seconds).toBeCloseTo(0.5);
    // 时间推进后，不触发 onended，队列估算也应准确归零。
    context.currentTime = 6; expect(scheduler.seconds).toBe(0);
    scheduler.schedule(buffer(0.2)); expect(nodes[3].start).toHaveBeenCalledWith(6);
  });
  it('stops every scheduled block on pause and starts a new queue immediately', () => {
    const { scheduler, nodes, context } = fixture();
    scheduler.schedule(buffer(2)); scheduler.schedule(buffer(2)); scheduler.clear();
    expect(nodes.every(node => node.stop.mock.calls.length === 1 && node.onended === null)).toBe(true);
    expect(scheduler.seconds).toBe(0);
    context.currentTime = 5.5; scheduler.schedule(buffer(1)); expect(nodes[2].start).toHaveBeenCalledWith(5.5);
  });
  it('bounds retained audio to 60 seconds and counts by audio time while suspended', () => {
    const { scheduler, context } = fixture();
    scheduler.schedule(buffer(40)); scheduler.schedule(buffer(20));
    expect(() => scheduler.schedule(buffer(0.1))).toThrow('AUDIO_QUEUE_LIMIT');
    context.currentTime += 10; expect(scheduler.seconds).toBe(50);
    scheduler.schedule(buffer(5)); expect(scheduler.seconds).toBe(55);
  });
});
