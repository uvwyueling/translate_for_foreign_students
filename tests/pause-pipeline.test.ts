import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { PausePipeline } from '../server/pause-pipeline';
import type { ServerEvent } from '../shared/protocol';

class FakeSocket extends EventEmitter {
  readyState = 0; bufferedAmount = 0;
  sent: { header: { status: number }; payload: { data: { seq: number; audio: string } } }[] = [];
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  open() { this.readyState = 1; this.emit('open'); }
  close() { this.readyState = 3; this.emit('close'); }
  terminate() { this.close(); }
  result(final = true) {
    this.emit('message', Buffer.from(JSON.stringify({ header: { code: 0, status: final ? 2 : 1 }, payload: {
      streamtrans_results: { text: Buffer.from(JSON.stringify({ src: '测试', dst: 'Test.', wb: 0, we: 40, is_final: 1 })).toString('base64') },
      tts_results: { id: '0', seq: 1, status: 2, audio: 'AAA=' },
    } })));
  }
}
let pipeline: PausePipeline;
let sockets: FakeSocket[], events: ServerEvent[];
let ready = vi.fn<() => void>();
let failed = vi.fn<(code: string, message: string, retryable: boolean) => void>();
beforeEach(() => {
  vi.useFakeTimers(); sockets = []; events = []; ready = vi.fn(); failed = vi.fn();
  pipeline = new PausePipeline({ appId: 'test', apiKey: 'test', apiSecret: 'test' }, event => events.push(event), ready, failed, true, () => {
    const socket = new FakeSocket(); sockets.push(socket); return socket as unknown as WebSocket;
  });
});
afterEach(() => { pipeline.stop(); vi.clearAllTimers(); vi.useRealTimers(); });
const voiced = () => { const frame = Buffer.alloc(1280); for (let i = 0; i < frame.length; i += 2) frame.writeInt16LE(5000, i); return frame; };
const frame = async (voice: boolean) => { pipeline.push(voice ? voiced() : Buffer.alloc(1280)); await vi.advanceTimersByTimeAsync(40); };
describe('pause-based upstream session handoff', () => {
  it('ends after 800 ms silence, preserves audio output, and restarts without resetting browser audio sequence', async () => {
    pipeline.start(); sockets[0].open();
    for (let i = 0; i < 5; i++) await frame(true);
    for (let i = 0; i < 19; i++) await frame(false);
    expect(sockets[0].sent.some(m => m.header.status === 2)).toBe(false);
    await frame(false); expect(sockets[0].sent.at(-1)!.header.status).toBe(2);
    // 结束处理中到达的下一句音频不能丢失，也不能提前开第二条上游。
    await frame(true); expect(sockets).toHaveLength(1);
    sockets[0].result(); expect(sockets).toHaveLength(2); expect(sockets[0].readyState).toBe(3);
    sockets[1].open(); await vi.advanceTimersByTimeAsync(40);
    expect(sockets[1].sent[0].header.status).toBe(0);
    expect(Buffer.from(sockets[1].sent[0].payload.data.audio, 'base64')).toEqual(voiced());
    sockets[1].result();
    const audio = events.filter(e => e.type === 'audio');
    expect(audio.map(e => e.seq)).toEqual([0, 1]);
    const captions = events.filter(e => e.type === 'caption');
    expect(captions[0].id).not.toBe(captions[1].id);
    expect(captions.map(e => e.endMs)).toEqual([40, 1040]);
    expect(ready).toHaveBeenCalledTimes(1); expect(failed).not.toHaveBeenCalled();
  });
  it('does not flush before speech or on a brief within-sentence pause', async () => {
    pipeline.start(); sockets[0].open();
    for (let i = 0; i < 25; i++) await frame(false);
    for (let i = 0; i < 5; i++) await frame(true);
    for (let i = 0; i < 10; i++) await frame(false);
    await frame(true);
    expect(sockets[0].sent.every(m => m.header.status !== 2)).toBe(true);
    expect(failed).not.toHaveBeenCalled();
  });
  it('cancels timers and ignores late results after pause or end', async () => {
    pipeline.start(); sockets[0].open(); await frame(true); pipeline.stop();
    sockets[0].result(); await vi.advanceTimersByTimeAsync(15000);
    expect(events).toHaveLength(0); expect(sockets).toHaveLength(1); expect(failed).not.toHaveBeenCalled();
  });
  it('bounds connecting buffers instead of accumulating unlimited classroom audio', () => {
    pipeline.start();
    for (let i = 0; i < 151; i++) pipeline.push(voiced());
    expect(failed).toHaveBeenCalledWith('SEGMENT_BACKLOG', expect.any(String), false);
  });
  it('times out a half-open upstream connection', async () => {
    pipeline.start(); await vi.advanceTimersByTimeAsync(10000);
    expect(failed).toHaveBeenCalledWith('SEGMENT_CONNECT_TIMEOUT', expect.any(String), true);
  });
});
