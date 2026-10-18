import { createHmac } from 'node:crypto';
import type { ServerEvent } from '../shared/protocol';

export interface Credentials { appId: string; apiKey: string; apiSecret: string }
export function signedUrl(credentials: Credentials, now = new Date()): string {
  const url = new URL('wss://ws-api.xf-yun.com/v1/private/simult_interpretation');
  const date = now.toUTCString();
  const input = `host: ${url.host}\ndate: ${date}\nGET ${url.pathname} HTTP/1.1`;
  const signature = createHmac('sha256', credentials.apiSecret).update(input).digest('base64');
  const authorization = `api_key="${credentials.apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`;
  url.searchParams.set('authorization', Buffer.from(authorization).toString('base64'));
  url.searchParams.set('date', date);
  url.searchParams.set('host', url.host);
  return url.toString();
}
export function audioRequest(appId: string, audio: Buffer, seq: number, last = false) {
  const status = last ? 2 : seq === 0 ? 0 : 1;
  return {
    header: { app_id: appId, status },
    ...(seq === 0 ? { parameter: {
      ist: { accent: 'mandarin', domain: 'ist_ed_open', language: 'zh_cn', vto: 15000, eos: 150000 },
      streamtrans: { from: 'cn', to: 'en' },
      tts: { vcn: 'x2_john', tts_results: { encoding: 'raw', sample_rate: 16000, channels: 1, bit_depth: 16, frame_size: 0 } },
    } } : {}),
    payload: { data: { audio: audio.toString('base64'), encoding: 'raw', sample_rate: 16000, seq: seq + 1, status } },
  };
}
type Recognition = { sn: number; pgs?: string; rg?: number[]; sub_end?: boolean; ls?: boolean; ed?: number; ws?: { cw: { w: string }[] }[] };
export class RecognitionAssembler {
  private parts = new Map<number, string>();
  update(result: Recognition): string {
    if (result.pgs === 'rpl' && result.rg?.length === 2) {
      for (const key of this.parts.keys()) if (key >= result.rg[0] && key <= result.rg[1]) this.parts.delete(key);
    }
    this.parts.set(result.sn, result.ws?.map(w => w.cw[0]?.w ?? '').join('') ?? '');
    while (this.parts.size > 64) this.parts.delete(this.parts.keys().next().value!);
    const text = [...this.parts].sort((a, b) => a[0] - b[0]).map(x => x[1]).join('');
    if (result.sub_end || result.ls) this.parts.clear();
    return text;
  }
}
export function vendorError(code: number): { message: string; retryable: boolean } {
  if ([10005, 10006, 10007, 10008, 10110, 10105, 10106, 11200, 11201, 11202, 11203, 11204, 11205, 11206, 11207, 11208].includes(code))
    return { message: '服务鉴权、权限或额度异常，请联系项目负责人检查账号。', retryable: false };
  // 未知业务错误不盲目消耗额度重试，网络断连在连接层单独恢复。
  return { message: '同传服务返回异常，请联系项目负责人核对排查信息后重试。', retryable: false };
}
function decode<T>(text: string): T { return JSON.parse(Buffer.from(text, 'base64').toString('utf8')) as T; }

/** 真实响应中 id 是音频块索引；seq 在每段 status=2 后重置，不能以 id 分句。 */
export class VendorDecoder {
  private recognition = new RecognitionAssembler();
  private audioSeq = 0;
  private pending = new Map<number, { audio: Buffer; final: boolean }>();
  private nextTtsSeq: number | undefined;
  private waitingSince = 0;
  private bytes = 0;
  constructor(private sessionId: string, private emit: (event: ServerEvent) => void, private emitAudio = true) {}
  checkAudioTimeout(now = Date.now()) {
    if (this.waitingSince && now - this.waitingSince > 12000) throw new Error('AUDIO_SEQUENCE_TIMEOUT');
  }
  accept(raw: string): boolean {
    const response = JSON.parse(raw);
    if (response.header?.code) {
      const code = Number(response.header.code);
      this.emit({ type: 'error', code: `XFYUN_${code}`, ...vendorError(code) });
      return false;
    }
    const payload = response.payload ?? {};
    if (payload.recognition_results?.text) {
      const r = decode<Recognition>(payload.recognition_results.text);
      this.emit({ type: 'recognition', sessionId: this.sessionId, text: this.recognition.update(r), final: !!(r.sub_end || r.ls), endMs: Number(r.ed ?? 0) });
    }
    if (payload.streamtrans_results?.text) {
      const t = decode<{ src: string; dst: string; wb: number; we: number; is_final: number }>(payload.streamtrans_results.text);
      this.emit({ type: 'caption', sessionId: this.sessionId, id: `t:${t.wb}`, zh: t.src, en: t.dst, final: t.is_final === 1, endMs: t.we });
    }
    const tts = payload.tts_results;
    if (tts && this.emitAudio) {
      const seq = Number(tts.seq);
      const chunk = Buffer.from(tts.audio ?? '', 'base64');
      if (!Number.isInteger(seq) || seq < 0 || chunk.length % 2 !== 0 || (tts.encoding && tts.encoding !== 'raw') || (tts.sample_rate && Number(tts.sample_rate) !== 16000)) throw new Error('INVALID_PCM');
      this.nextTtsSeq ??= seq === 0 ? 0 : 1;
      if (seq >= this.nextTtsSeq && !this.pending.has(seq)) {
        this.pending.set(seq, { audio: chunk, final: Number(tts.status) === 2 }); this.bytes += chunk.length;
      }
      if (this.bytes > 960000 || this.pending.size > 64 || seq - this.nextTtsSeq > 64) throw new Error('AUDIO_BUFFER_LIMIT');
      while (this.pending.has(this.nextTtsSeq)) {
        const block = this.pending.get(this.nextTtsSeq)!;
        this.pending.delete(this.nextTtsSeq++); this.bytes -= block.audio.length;
        if (block.audio.length) this.emit({ type: 'audio', sessionId: this.sessionId, seq: this.audioSeq++, pcm: block.audio.toString('base64'), sampleRate: 16000 });
        if (block.final) {
          if (this.pending.size) throw new Error('AUDIO_SEQUENCE_AFTER_END');
          this.nextTtsSeq = undefined;
          break;
        }
      }
      if (this.pending.size) this.waitingSince ||= Date.now(); else this.waitingSince = 0;
      this.checkAudioTimeout();
    }
    return response.header?.status !== 2;
  }
}
