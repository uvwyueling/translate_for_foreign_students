export type Mode = 'mock' | 'live';
export type SpeechMode = 'provider' | 'local';
export type Segmentation = 'continuous' | 'pause';
export type Phase = 'idle' | 'checking' | 'connecting' | 'running' | 'paused' | 'reconnecting' | 'error' | 'ended';
export interface Caption { id: string; zh: string; en: string; final: boolean; at: number }
export interface UplinkDiagnostics {
  receivedFrames: number; forwardedFrames: number; queuedFrames: number; peakQueuedFrames: number;
  networkBufferedBytes: number; blockedMs: number; maxTimerDelayMs: number;
}
export type ServerEvent =
  | { type: 'connecting'; sessionId: string }
  | { type: 'ready'; sessionId: string; mode: Mode }
  | { type: 'pong'; at: number }
  | { type: 'recognition'; sessionId: string; text: string; final: boolean; endMs: number }
  | { type: 'caption'; sessionId: string; id: string; zh: string; en: string; final: boolean; endMs: number }
  | { type: 'audio'; sessionId: string; seq: number; pcm: string; sampleRate: number }
  | { type: 'mock-speech'; sessionId: string; seq: number; text: string }
  | { type: 'handoff'; sessionId: string }
  | { type: 'error'; code: string; message: string; retryable: boolean; uplink?: UplinkDiagnostics };
export const MAX_CAPTIONS = 60;
export function upsertCaption(rows: Caption[], row: Caption): Caption[] {
  const index = rows.findIndex(item => item.id === row.id);
  if (index < 0) return [...rows, row].slice(-MAX_CAPTIONS);
  if (rows[index].final && !row.final) return rows;
  return rows.map((item, i) => i === index ? row : item);
}
