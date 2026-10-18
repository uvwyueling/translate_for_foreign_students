import { PcmResampler } from './resampler';
declare const sampleRate: number;
declare class AudioWorkletProcessor { port: MessagePort }
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;
class CaptureProcessor extends AudioWorkletProcessor {
  private resampler = new PcmResampler(sampleRate);
  private callbacks = 0;
  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0];
    if (!input) return true;
    for (const frame of this.resampler.push(input)) {
      // 明确小端编码，避免依赖平台字节序。
      const buffer = new ArrayBuffer(frame.length * 2), view = new DataView(buffer);
      for (let i = 0; i < frame.length; i++) view.setInt16(i * 2, frame[i], true);
      this.port.postMessage({ type: 'pcm', buffer }, [buffer]);
    }
    if (++this.callbacks % 20 === 0) {
      let sum = 0; for (const value of input) sum += value * value;
      this.port.postMessage({ type: 'level', level: Math.sqrt(sum / input.length) });
    }
    return true;
  }
}
registerProcessor('classroom-capture', CaptureProcessor);
