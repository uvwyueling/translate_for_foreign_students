export const PCM_FRAME_MS = 40;
export const MIN_PCM_SEND_GAP_MS = 35;

/** 按预计发送时刻修正小幅延后；错过整帧时重置，避免集中补发。 */
export function nextPcmDeadline(previous: number | undefined, now: number): number {
  const target = previous === undefined || now - previous >= PCM_FRAME_MS ? now : previous;
  return Math.max(target + PCM_FRAME_MS, now + MIN_PCM_SEND_GAP_MS);
}
