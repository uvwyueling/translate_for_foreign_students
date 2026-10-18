import processorUrl from './capture.worklet.ts?worker&url';
export class Microphone {
  private stream?: MediaStream;
  private context?: AudioContext;
  private node?: AudioWorkletNode;
  private generation = 0;
  async start(onFrame: (frame: ArrayBuffer) => void, onLevel: (value: number) => void, onFailure: () => void) {
    this.stop();
    const generation = this.generation;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    if (generation !== this.generation) { stream.getTracks().forEach(t => t.stop()); return; }
    this.stream = stream;
    try {
      const context = new AudioContext(); this.context = context;
      await context.resume();
      await context.audioWorklet.addModule(processorUrl);
      if (generation !== this.generation) return;
      const source = context.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(context, 'classroom-capture'); this.node = node;
      const silence = context.createGain(); silence.gain.value = 0;
      source.connect(node).connect(silence).connect(context.destination);
      node.port.onmessage = event => {
        if (generation !== this.generation) return;
        if (event.data.type === 'pcm') onFrame(event.data.buffer);
        else onLevel(event.data.level);
      };
      stream.getTracks().forEach(t => t.addEventListener('ended', () => { if (generation === this.generation) onFailure(); }));
      context.onstatechange = () => { if (generation === this.generation && context.state === 'suspended') onFailure(); };
    } catch (error) { if (generation === this.generation) this.stop(); throw error; }
  }
  stop() {
    this.generation++;
    if (this.node) { this.node.port.onmessage = null; this.node.disconnect(); }
    this.node = undefined;
    this.stream?.getTracks().forEach(t => t.stop()); this.stream = undefined;
    void this.context?.close(); this.context = undefined;
  }
}
