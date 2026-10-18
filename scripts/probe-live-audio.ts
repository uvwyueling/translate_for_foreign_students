import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { audioRequest, signedUrl, VendorDecoder } from '../server/xfyun';
import { readConfig } from '../server/bridge';

// 手动运行：仅使用明确指定的合成 WAV 样本；不读取麦克风，不打印或保存正文、语音、密钥。
// 此脚本调用真实服务并消耗少量额度，不纳入自动化测试。
process.loadEnvFile('.env');
const config = readConfig();
if (!config.credentials || !process.argv[2]) throw new Error('需要完整后端配置和合成测试 WAV 路径。');
const wav = readFileSync(process.argv[2]);
if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw new Error('仅支持 PCM WAV。');
let pcm = Buffer.alloc(0), formatValid = false;
for (let offset = 12; offset + 8 <= wav.length;) {
  const id = wav.toString('ascii', offset, offset + 4), size = wav.readUInt32LE(offset + 4), start = offset + 8;
  if (id === 'fmt ') formatValid = wav.readUInt16LE(start) === 1 && wav.readUInt16LE(start + 2) === 1 && wav.readUInt32LE(start + 4) === 16000 && wav.readUInt16LE(start + 14) === 16;
  if (id === 'data') pcm = wav.subarray(start, start + size);
  offset = start + size + size % 2;
}
if (!formatValid || pcm.length < 3200 || pcm.length > 480000) throw new Error('样本必须为 0.1–15 秒的 16 kHz 单声道 PCM16。');
let lastVoicedByte = 0;
for (let offset = 0; offset < pcm.length; offset += 640) {
  const end = Math.min(offset + 640, pcm.length); let sum = 0;
  for (let i = offset; i + 1 < end; i += 2) sum += (pcm.readInt16LE(i) / 32768) ** 2;
  if (Math.sqrt(sum / ((end - offset) / 2)) > 0.008) lastVoicedByte = end;
}
const tailMs = Number(process.argv[4] ?? 4000);
if (![600, 4000, 8000].includes(tailMs)) throw new Error('测试尾部静音必须为 600、4000 或 8000 毫秒。');
pcm = Buffer.concat([pcm, Buffer.alloc(32 * tailMs)]);
const vtoMs = Number(process.argv[3] ?? 15000);
if (![3000, 5000, 15000].includes(vtoMs)) throw new Error('测试强切参数必须为 3000、5000 或 15000。');
const report = { vtoMs, tailMs, inputSeconds: pcm.length / 32000, lastVoicedSampleMs: lastVoicedByte / 32, lastVoicedUploadMs: null as number | null, finalFrameSentMs: null as number | null, firstRecognitionMs: null as number | null, firstTranslationMs: null as number | null, firstAudioMs: null as number | null, translationAfterVoiceMs: null as number | null, audioAfterVoiceMs: null as number | null, recognitionPackets: 0, translationPackets: 0, ttsPackets: 0, ttsBytes: 0, decoderAudioPackets: 0, decoderAudioBeforeEnd: 0, decoderErrors: 0, providerCodes: [] as number[], firstTtsMetadata: [] as unknown[], lastTtsMetadata: undefined as unknown };
const decoder = new VendorDecoder('probe', event => { if (event.type === 'audio') { report.decoderAudioPackets++; if (!endSent) report.decoderAudioBeforeEnd++; } });
let endSent = false, closed = false;
let streamStarted = 0;
const socket = new WebSocket(signedUrl(config.credentials), { handshakeTimeout: 8000, maxPayload: 2_000_000 });
socket.on('error', () => { /* 不打印可能包含鉴权 URL 的错误对象。 */ });
socket.on('close', () => { closed = true; });
socket.on('unexpected-response', (_req, response) => { report.providerCodes.push(response.statusCode ?? -1); response.resume(); socket.terminate(); });
socket.on('message', raw => {
  try {
    const response = JSON.parse(raw.toString());
    if (response.header?.code) report.providerCodes.push(Number(response.header.code));
    const p = response.payload ?? {};
    const elapsed = Math.round(performance.now() - streamStarted);
    if (p.recognition_results) { report.recognitionPackets++; report.firstRecognitionMs ??= elapsed; }
    if (p.streamtrans_results) { report.translationPackets++; report.firstTranslationMs ??= elapsed; }
    if (p.tts_results) {
      const t = p.tts_results;
      report.ttsPackets++; report.ttsBytes += Buffer.from(t.audio ?? '', 'base64').length;
      if (t.audio) report.firstAudioMs ??= elapsed;
      const meta = { id: t.id, seq: t.seq, status: t.status, headerStatus: response.header?.status, bytes: Buffer.from(t.audio ?? '', 'base64').length, afterEnd: endSent, encoding: t.encoding, sampleRate: t.sample_rate };
      if (report.firstTtsMetadata.length < 12) report.firstTtsMetadata.push(meta);
      report.lastTtsMetadata = meta;
    }
    try { decoder.accept(raw.toString()); } catch { report.decoderErrors++; }
  } catch { report.decoderErrors++; }
});
await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', () => reject(new Error('测试服务连接失败。'))); socket.once('close', () => reject(new Error('测试服务连接已关闭。'))); });
streamStarted = performance.now();
let seq = 0;
for (let offset = 0; offset < pcm.length && !closed; offset += 1280) {
  const frame = Buffer.alloc(1280); pcm.copy(frame, 0, offset, Math.min(offset + 1280, pcm.length));
  const request = audioRequest(config.credentials.appId, frame, seq++);
  if (request.parameter) request.parameter.ist.vto = vtoMs;
  socket.send(JSON.stringify(request));
  if (offset < lastVoicedByte && offset + 1280 >= lastVoicedByte) report.lastVoicedUploadMs = Math.round(performance.now() - streamStarted);
  await delay(40);
}
endSent = true;
report.finalFrameSentMs = Math.round(performance.now() - streamStarted);
if (!closed) socket.send(JSON.stringify(audioRequest(config.credentials.appId, Buffer.alloc(0), seq, true)));
await delay(8000);
socket.close(); const timer = setTimeout(() => socket.terminate(), 1000); timer.unref();
if (report.lastVoicedUploadMs !== null) {
  if (report.firstTranslationMs !== null) report.translationAfterVoiceMs = report.firstTranslationMs - report.lastVoicedUploadMs;
  if (report.firstAudioMs !== null) report.audioAfterVoiceMs = report.firstAudioMs - report.lastVoicedUploadMs;
}
console.info(JSON.stringify(report, null, 2));
