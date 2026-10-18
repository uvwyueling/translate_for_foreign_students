/** 有状态线性重采样；跨 AudioWorklet 回调保留相位和余样本。 */
export class PcmResampler {
  private buffer: number[] = [];
  private position = 0;
  private frame: number[] = [];
  constructor(private inputRate: number, private outputRate = 16000, private frameSize = 640) {}
  push(input: Float32Array): Int16Array[] {
    for (const sample of input) this.buffer.push(sample);
    const frames: Int16Array[] = [];
    const step = this.inputRate / this.outputRate;
    while (this.position + 1 < this.buffer.length) {
      const i = Math.floor(this.position), fraction = this.position - i;
      const value = Math.max(-1, Math.min(1, this.buffer[i] * (1 - fraction) + this.buffer[i + 1] * fraction));
      this.frame.push(Math.round(value * (value < 0 ? 32768 : 32767)));
      this.position += step;
      if (this.frame.length === this.frameSize) { frames.push(Int16Array.from(this.frame)); this.frame = []; }
    }
    const consumed = Math.min(Math.floor(this.position), this.buffer.length);
    this.buffer.splice(0, consumed); this.position -= consumed;
    return frames;
  }
}
