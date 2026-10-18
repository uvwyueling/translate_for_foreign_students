import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { PausePipeline } from '../server/pause-pipeline';
import { readConfig } from '../server/bridge';

// 手动真实 API 短测：固定合成 WAV 重复两遍，只输出数字，不记录字幕或音频。
process.loadEnvFile('.env');
const credentials = readConfig().credentials;
if (!credentials || !process.argv[2]) throw new Error('需要后端凭证和合成 WAV 路径。');
const wav = readFileSync(process.argv[2]);
let pcm = Buffer.alloc(0), valid = false;
for (let at = 12; at + 8 <= wav.length;) {
  const id = wav.toString('ascii', at, at + 4), size = wav.readUInt32LE(at + 4), start = at + 8;
  if (id === 'fmt ') valid = wav.readUInt16LE(start) === 1 && wav.readUInt16LE(start + 2) === 1 && wav.readUInt32LE(start + 4) === 16000 && wav.readUInt16LE(start + 14) === 16;
  if (id === 'data') pcm = wav.subarray(start, start + size);
  at = start + size + size % 2;
}
if (!valid || pcm.length < 3200 || pcm.length > 480000) throw new Error('需要 0.1–15 秒 16 kHz 单声道 PCM16 WAV。');
let lastVoiceByte = 0;
for (let offset = 0; offset < pcm.length; offset += 640) {
  const end = Math.min(offset + 640, pcm.length); let sum = 0;
  for (let i = offset; i + 1 < end; i += 2) sum += (pcm.readInt16LE(i) / 32768) ** 2;
  if (Math.sqrt(sum / ((end - offset) / 2)) > 0.008) lastVoiceByte = end;
}
const gap = Buffer.alloc(32000 * 2), source = Buffer.concat([pcm, gap, pcm, gap]);
const voiceOffsets = [lastVoiceByte, pcm.length + gap.length + lastVoiceByte];
const report = { test: 'real-pause-pipeline-two-synthetic-utterances', inputSeconds: source.length / 32000, pieces: [] as { piece: number; voiceUploadedMs: number | null; firstTranslationMs: number | null; firstAudioMs: number | null; translationAfterVoiceMs: number | null; audioAfterVoiceMs: number | null }[], audioPackets: 0, errors: [] as string[] };
let startedAt = 0, currentPiece = 0;
const record = (index: number) => {
  let value = report.pieces.find(item => item.piece === index);
  if (!value) { value = { piece: index, voiceUploadedMs: null, firstTranslationMs: null, firstAudioMs: null, translationAfterVoiceMs: null, audioAfterVoiceMs: null }; report.pieces.push(value); }
  return value;
};
let resolveReady!: () => void;
const ready = new Promise<void>(resolve => { resolveReady = resolve; });
const pipeline = new PausePipeline(credentials, event => {
  const elapsed = Math.round(performance.now() - startedAt);
  if (event.type === 'error') report.errors.push(event.code);
  if (event.type === 'caption') {
    currentPiece = Number(event.id.split(':')[1]); record(currentPiece).firstTranslationMs ??= elapsed;
  }
  if (event.type === 'audio') { report.audioPackets++; if (currentPiece) record(currentPiece).firstAudioMs ??= elapsed; }
}, resolveReady, code => { report.errors.push(code); resolveReady(); });
pipeline.start(); await ready;
startedAt = performance.now();
for (let offset = 0; offset < source.length && !report.errors.length; offset += 1280) {
  const frame = Buffer.alloc(1280); source.copy(frame, 0, offset, Math.min(offset + 1280, source.length));
  pipeline.push(frame);
  for (let i = 0; i < voiceOffsets.length; i++) if (offset < voiceOffsets[i] && offset + 1280 >= voiceOffsets[i]) record(i + 1).voiceUploadedMs = Math.round(performance.now() - startedAt);
  await delay(40);
}
await delay(1500); pipeline.stop();
for (const piece of report.pieces) if (piece.voiceUploadedMs !== null) {
  if (piece.firstTranslationMs !== null) piece.translationAfterVoiceMs = piece.firstTranslationMs - piece.voiceUploadedMs;
  if (piece.firstAudioMs !== null) piece.audioAfterVoiceMs = piece.firstAudioMs - piece.voiceUploadedMs;
}
console.info(JSON.stringify(report, null, 2));
if (report.errors.length || report.pieces.length !== 2 || report.pieces.some(piece => piece.firstAudioMs === null)) process.exitCode = 1;
