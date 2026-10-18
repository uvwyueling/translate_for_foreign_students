export interface Metrics {
  activeSeconds: number; uploadedSeconds: number; reconnects: number; interruptions: number;
  maxQueueSeconds: number; rttMs: number | null;
  partialLatencyMs: number[]; finalLatencyMs: number[]; recoveryMs: number[]; audioQueueWaitMs: number[];
  captionConfirmationMs: number[]; localSpeechStartMs: number[];
}
export function emptyMetrics(): Metrics { return { activeSeconds: 0, uploadedSeconds: 0, reconnects: 0, interruptions: 0, maxQueueSeconds: 0, rttMs: null, partialLatencyMs: [], finalLatencyMs: [], recoveryMs: [], audioQueueWaitMs: [], captionConfirmationMs: [], localSpeechStartMs: [] }; }
export function sample(values: number[], value: number) { if (Number.isFinite(value) && value >= 0) { values.push(Math.round(value)); if (values.length > 300) values.shift(); } }
export function summarize(values: number[]) {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  return { samples: ordered.length, medianMs: ordered[Math.floor(ordered.length / 2)], p95Ms: ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * 0.95))], maxMs: ordered.at(-1) };
}
