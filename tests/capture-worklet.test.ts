import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Message = { type: string; buffer?: ArrayBuffer; renderCallbacks?: number; inputCallbacks?: number; level?: number };
type Processor = { process(inputs: Float32Array[][]): boolean };
let ProcessorClass: new () => Processor;
let messages: Message[];
beforeEach(async () => {
  vi.resetModules(); messages = [];
  vi.stubGlobal('sampleRate', 48000);
  vi.stubGlobal('AudioWorkletProcessor', class { port = { postMessage: (message: Message) => messages.push(message) }; });
  vi.stubGlobal('registerProcessor', (name: string, processor: typeof ProcessorClass) => {
    expect(name).toBe('classroom-capture'); ProcessorClass = processor;
  });
  await import('../src/audio/capture.worklet');
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('capture worklet signal path', () => {
  it('reports an alive processor with no microphone input without inventing PCM or volume', () => {
    const processor = new ProcessorClass();
    expect(messages).toEqual([{ type: 'ready' }]);
    for (let i = 0; i < 40; i++) expect(processor.process([[]])).toBe(true);
    expect(messages.at(-1)).toEqual({ type: 'heartbeat', renderCallbacks: 40, inputCallbacks: 0 });
    expect(messages.some(message => message.type === 'pcm' || message.type === 'level')).toBe(false);
  });
  it('continues generating 40 ms PCM frames for silent input', () => {
    const processor = new ProcessorClass();
    for (let i = 0; i < 375; i++) processor.process([[new Float32Array(128)]]);
    const pcm = messages.filter(message => message.type === 'pcm');
    expect(pcm.length).toBeGreaterThanOrEqual(24); expect(pcm.length).toBeLessThanOrEqual(25);
    expect(pcm.every(message => message.buffer?.byteLength === 1280 && new Uint8Array(message.buffer).every(byte => byte === 0))).toBe(true);
    expect(messages.filter(message => message.type === 'level').every(message => message.level === 0)).toBe(true);
  });
  it('encodes microphone samples as signed little endian PCM16', () => {
    const processor = new ProcessorClass();
    for (let i = 0; i < 20; i++) processor.process([[new Float32Array(128).fill(-0.5)]]);
    const buffer = messages.find(message => message.type === 'pcm')!.buffer!;
    expect(new DataView(buffer).getInt16(0, true)).toBe(-16384);
    expect([...new Uint8Array(buffer).slice(0, 2)]).toEqual([0, 192]);
    expect(messages.at(-1)).toEqual({ type: 'level', level: 0.5 });
  });
});
