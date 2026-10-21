import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Microphone } from '../src/audio/capture';

const graphNode = () => ({ connect: vi.fn((next: unknown) => next), disconnect: vi.fn() });
function fixture() {
  const track = Object.assign(new EventTarget(), { readyState: 'live', enabled: true, muted: false, stop: vi.fn() });
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const source = graphNode(), silence = { ...graphNode(), gain: { value: 1 } };
  const node = { ...graphNode(), port: { onmessage: null as ((event: { data: unknown }) => void) | null, close: vi.fn() }, onprocessorerror: null as (() => void) | null };
  const context = {
    state: 'running', sampleRate: 48000, destination: {}, onstatechange: null as (() => void) | null,
    resume: vi.fn(async () => {}), close: vi.fn(async () => {}), audioWorklet: { addModule: vi.fn(async () => {}) },
    createMediaStreamSource: vi.fn(() => source), createGain: vi.fn(() => silence),
  };
  const constructed = vi.fn();
  vi.stubGlobal('AudioContext', class { constructor() { constructed(); return context; } });
  vi.stubGlobal('AudioWorkletNode', class { constructor() { return node; } });
  const getUserMedia = vi.fn(async () => stream);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  const microphone = new Microphone(), frame = vi.fn(), level = vi.fn(), failed = vi.fn();
  return { microphone, frame, level, failed, context, source, silence, node, track, stream, getUserMedia, constructed };
}
let f: ReturnType<typeof fixture>;
beforeEach(() => { f = fixture(); });
afterEach(() => { f.microphone.stop(); vi.unstubAllGlobals(); });

describe('microphone startup and diagnostics', () => {
  it('resumes the prepared context before requesting permission and reuses it for capture', async () => {
    const prepared = f.microphone.prepare();
    expect(f.context.resume).toHaveBeenCalledTimes(1);
    expect(f.getUserMedia).not.toHaveBeenCalled();
    await prepared; await f.microphone.start(f.frame, f.level, f.failed);
    expect(f.constructed).toHaveBeenCalledTimes(1);
    expect(f.context.resume).toHaveBeenCalledTimes(1);
    expect(f.microphone.diagnostics).toMatchObject({ stage: 'capturing', contextState: 'running', sampleRate: 48000, trackState: 'live' });
    expect(f.silence.gain.value).toBe(0);
    expect(f.source.connect).toHaveBeenCalledWith(f.node);
  });
  it('distinguishes worklet readiness, render callbacks, input and actual PCM frames', async () => {
    await f.microphone.start(f.frame, f.level, f.failed);
    const send = (data: unknown) => f.node.port.onmessage!({ data });
    send({ type: 'ready' }); send({ type: 'heartbeat', renderCallbacks: 40, inputCallbacks: 20 });
    expect(f.level).not.toHaveBeenCalled(); expect(f.frame).not.toHaveBeenCalled();
    const buffer = new ArrayBuffer(1280);
    send({ type: 'pcm', buffer }); send({ type: 'level', level: 0.1 });
    expect(f.microphone.diagnostics).toMatchObject({ workletReady: true, renderCallbacks: 40, inputCallbacks: 20, frames: 1 });
    expect(f.frame).toHaveBeenCalledWith(buffer); expect(f.level).toHaveBeenCalledWith(0.1);
    f.track.muted = true;
    expect(f.microphone.diagnostics.trackMuted).toBe(true);
  });
  it('reports processor exceptions and Safari interrupted states without waiting for the watchdog', async () => {
    await f.microphone.start(f.frame, f.level, f.failed);
    f.node.onprocessorerror!(); expect(f.failed).toHaveBeenLastCalledWith('CAPTURE_PROCESSOR_ERROR');
    f.context.state = 'interrupted'; f.context.onstatechange!();
    expect(f.failed).toHaveBeenLastCalledWith('CAPTURE_CONTEXT_INTERRUPTED');
    f.track.dispatchEvent(new Event('ended')); expect(f.failed).toHaveBeenLastCalledWith('CAPTURE_TRACK_ENDED');
    const lateFailure = f.node.onprocessorerror!, lateMessage = f.node.port.onmessage!;
    f.microphone.stop(); f.failed.mockClear();
    lateFailure(); lateMessage({ data: { type: 'pcm', buffer: new ArrayBuffer(1280) } });
    expect(f.failed).not.toHaveBeenCalled(); expect(f.frame).not.toHaveBeenCalled();
    expect(f.node.port.close).toHaveBeenCalled(); expect(f.source.disconnect).toHaveBeenCalled();
    expect(f.silence.disconnect).toHaveBeenCalled(); expect(f.context.onstatechange).toBeNull();
  });
  it('releases a permission result that arrives after stopping', async () => {
    let grant!: (stream: typeof f.stream) => void;
    f.getUserMedia.mockImplementationOnce(() => new Promise(resolve => { grant = resolve; }));
    const starting = f.microphone.start(f.frame, f.level, f.failed);
    expect(f.context.resume).toHaveBeenCalled(); expect(f.microphone.diagnostics.stage).toBe('permission');
    f.microphone.stop(); grant(f.stream); await starting;
    expect(f.track.stop).toHaveBeenCalledTimes(1);
    expect(f.context.createMediaStreamSource).not.toHaveBeenCalled();
  });
  it('does not attach an audio graph when stopped during module loading', async () => {
    let loaded!: () => void;
    f.context.audioWorklet.addModule.mockImplementationOnce(() => new Promise(resolve => { loaded = resolve; }));
    const starting = f.microphone.start(f.frame, f.level, f.failed);
    await vi.waitFor(() => expect(f.microphone.diagnostics.stage).toBe('worklet'));
    f.microphone.stop(); loaded(); await starting;
    expect(f.context.createMediaStreamSource).not.toHaveBeenCalled(); expect(f.track.stop).toHaveBeenCalledTimes(1);
  });
  it('closes its prepared context if microphone permission is denied', async () => {
    f.getUserMedia.mockRejectedValueOnce(new DOMException('Permission denied', 'NotAllowedError'));
    await expect(f.microphone.start(f.frame, f.level, f.failed)).rejects.toMatchObject({ name: 'NotAllowedError' });
    expect(f.context.close).toHaveBeenCalledTimes(1);
  });
});
