import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { PcmUplink } from '../server/pcm-uplink';

class FakeSocket {
  readyState = WebSocket.OPEN; bufferedAmount = 0;
  sent: { at: number; header: { status: number }; payload: { data: { seq: number; audio: string } } }[] = [];
  send(raw: string) { this.sent.push({ ...JSON.parse(raw), at: Date.now() }); }
}
let socket: FakeSocket, uplink: PcmUplink;
let failed = vi.fn();
const frame = (value: number) => { const pcm = Buffer.alloc(1280); pcm.writeUInt16LE(value); return pcm; };
beforeEach(() => {
  vi.useFakeTimers(); socket = new FakeSocket(); failed = vi.fn();
  uplink = new PcmUplink(socket as unknown as WebSocket, 'app', failed); uplink.start();
});
afterEach(() => { uplink.stop(); vi.clearAllTimers(); vi.useRealTimers(); });

describe('paced cloud audio upload', () => {
  it('turns a two-second arrival burst into ordered 40 ms uploads without discarding audio', async () => {
    for (let i = 0; i < 50; i++) uplink.push(frame(i));
    expect(socket.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(49 * 40);
    expect(socket.sent.map(item => item.payload.data.seq)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(socket.sent.map(item => Buffer.from(item.payload.data.audio, 'base64').readUInt16LE())).toEqual(Array.from({ length: 50 }, (_, i) => i));
    expect(socket.sent.slice(1).every((item, i) => item.at - socket.sent[i].at === 40)).toBe(true);
    expect(socket.sent.map(item => item.header.status)).toEqual([0, ...Array(49).fill(1)]);
    expect(failed).not.toHaveBeenCalled();
  });
  it('waits through brief backpressure and then preserves the queued phrase', async () => {
    socket.bufferedAmount = 65000;
    for (let i = 0; i < 30; i++) uplink.push(frame(i));
    await vi.advanceTimersByTimeAsync(1000);
    expect(socket.sent).toHaveLength(0); expect(failed).not.toHaveBeenCalled();
    socket.bufferedAmount = 0; await vi.advanceTimersByTimeAsync(30 * 40);
    expect(socket.sent.map(item => Buffer.from(item.payload.data.audio, 'base64').readUInt16LE())).toEqual(Array.from({ length: 30 }, (_, i) => i));
    expect(failed).not.toHaveBeenCalled();
  });
  it('resets the blocking deadline when the network recovers', async () => {
    socket.bufferedAmount = 65000; uplink.push(frame(1));
    await vi.advanceTimersByTimeAsync(4000);
    socket.bufferedAmount = 0; await vi.advanceTimersByTimeAsync(40);
    socket.bufferedAmount = 65000; uplink.push(frame(2));
    await vi.advanceTimersByTimeAsync(4000);
    socket.bufferedAmount = 0; await vi.advanceTimersByTimeAsync(40);
    expect(socket.sent).toHaveLength(2); expect(failed).not.toHaveBeenCalled();
  });
  it('stops persistent blockage instead of entering repeated automatic reconnects', async () => {
    socket.bufferedAmount = 65000; uplink.push(frame(1));
    await vi.advanceTimersByTimeAsync(6000);
    expect(failed).toHaveBeenCalledExactlyOnceWith('UPSTREAM_BACKPRESSURE', expect.any(String), false);
    socket.bufferedAmount = 0; uplink.push(frame(2)); await vi.advanceTimersByTimeAsync(1000);
    expect(socket.sent).toHaveLength(0);
  });
  it('bounds unsent PCM even when arriving frames keep accumulating', () => {
    socket.bufferedAmount = 65000;
    for (let i = 0; i < 151; i++) uplink.push(frame(i));
    expect(failed).toHaveBeenCalledExactlyOnceWith('UPSTREAM_INPUT_BACKLOG', expect.any(String), false);
    expect(socket.sent).toHaveLength(0);
  });
  it('drops pending audio on stop and sends only one matching end frame', async () => {
    uplink.push(frame(1)); uplink.push(frame(2)); uplink.stop(true); uplink.stop(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(socket.sent.map(item => item.header.status)).toEqual([0, 2]);
    expect(socket.sent[1].payload.data).toMatchObject({ seq: 2, audio: '' });
  });
});
