import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { PcmResampler } from '../src/audio/resampler';
import { OrderedInbox } from '../src/audio/player';
import { upsertCaption, type Caption, type ServerEvent } from '../shared/protocol';
import { audioRequest, RecognitionAssembler, signedUrl, VendorDecoder, vendorError } from '../server/xfyun';
import { emptyMetrics, sample, summarize } from '../src/lib/metrics';
const base64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64');
describe('PCM conversion', () => {
  it.each([44100, 48000, 16000])('keeps 40 ms framing and phase across callbacks at %i Hz', rate => {
    const input = Float32Array.from({ length: rate }, (_, i) => Math.sin(i / 53));
    const run = (size: number) => { const converter = new PcmResampler(rate); const frames: Int16Array[] = []; for (let i = 0; i < input.length; i += size) frames.push(...converter.push(input.slice(i, i + size))); return frames; };
    const frames = run(128), continuous = run(input.length);
    expect(frames.length).toBeGreaterThanOrEqual(24); expect(frames.length).toBeLessThanOrEqual(25);
    expect(frames.every(frame => frame.byteLength === 1280)).toBe(true);
    expect(frames.map(frame => [...frame])).toEqual(continuous.map(frame => [...frame]));
  });
  it('clamps PCM instead of wrapping on clipping', () => {
    const converter = new PcmResampler(16000, 16000, 2);
    expect([...converter.push(new Float32Array([-2, 2, 0]))[0]]).toEqual([-32768, 32767]);
  });
});
describe('caption revisions and bounded retention', () => {
  const row = (id: string, final = false): Caption => ({ id, final, zh: id, en: id, at: 1 });
  it('updates a segment and never replaces a final segment with a partial', () => {
    let rows = upsertCaption([], row('a'));
    rows = upsertCaption(rows, { ...row('a', true), en: 'corrected' });
    expect(upsertCaption(rows, row('a'))).toEqual(rows);
    expect(rows).toHaveLength(1); expect(rows[0].en).toBe('corrected');
  });
  it('bounds a 45 minute stream to 60 rows', () => {
    let rows: Caption[] = [];
    for (let i = 0; i < 2700; i++) rows = upsertCaption(rows, row(String(i), true));
    expect(rows).toHaveLength(60); expect(rows[0].id).toBe('2640');
  });
  it('applies inclusive replacement ranges and resets after sentence end', () => {
    const assembler = new RecognitionAssembler();
    const part = (sn: number, w: string) => ({ sn, ws: [{ cw: [{ w }] }] });
    assembler.update(part(1, '旧')); assembler.update(part(2, '内容'));
    expect(assembler.update({ ...part(3, '新内容'), pgs: 'rpl', rg: [1, 2], sub_end: true })).toBe('新内容');
    expect(assembler.update(part(4, '下一句'))).toBe('下一句');
  });
});
describe('audio sequencing', () => {
  it('waits for missing chunks, rejects duplicates and bounds reordering', () => {
    const inbox = new OrderedInbox<string>();
    expect(inbox.accept(1, 'b')).toEqual([]);
    expect(inbox.accept(0, 'a')).toEqual(['a', 'b']);
    expect(inbox.accept(1, 'duplicate')).toEqual([]);
    expect(() => inbox.accept(100, 'far future')).toThrow('AUDIO_SEQUENCE_LIMIT');
    inbox.reset(); expect(inbox.accept(0, 'fresh session')).toEqual(['fresh session']);
  });
  it('streams TTS in sequence before completion and supports real per-block ids and sequence resets', () => {
    const events: ServerEvent[] = [];
    const decoder = new VendorDecoder('session', event => events.push(event));
    const tts = (seq: number, status: number, audio: number[]) => JSON.stringify({ header: { code: 0, status: 1 }, payload: { tts_results: { id: String(seq - 1), seq, status, audio: Buffer.from(audio).toString('base64') } } });
    decoder.accept(tts(1, 1, [1, 0]));
    expect(events).toHaveLength(1); // 不等 status=2，首块即可播放。
    decoder.accept(tts(1, 1, [1, 0])); expect(events).toHaveLength(1); // 段内重复不播放。
    decoder.accept(tts(3, 2, [3, 0])); expect(events).toHaveLength(1);
    decoder.accept(tts(2, 1, [2, 0])); expect(events).toHaveLength(3);
    decoder.accept(tts(1, 1, [4, 0])); decoder.accept(tts(2, 2, [5, 0]));
    expect(events.map(event => event.type === 'audio' && event.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(events.map(event => event.type === 'audio' && Buffer.from(event.pcm, 'base64')[0])).toEqual([1, 2, 3, 4, 5]);
  });
  it('bounds TTS reordering and reports unresolved gaps instead of waiting forever', () => {
    const tts = (seq: number) => JSON.stringify({ header: { code: 0 }, payload: { tts_results: { seq, status: 1, audio: 'AAA=' } } });
    const broken = new VendorDecoder('session', () => {});
    broken.accept(tts(1)); broken.accept(tts(3));
    expect(() => broken.checkAudioTimeout(Date.now() + 13000)).toThrow('AUDIO_SEQUENCE_TIMEOUT');
    expect(() => new VendorDecoder('session', () => {}).accept(tts(100))).toThrow('AUDIO_BUFFER_LIMIT');
  });
});
describe('vendor protocol', () => {
  it('signs the exact documented endpoint without exposing credentials in events', () => {
    const url = new URL(signedUrl({ appId: 'app', apiKey: 'key', apiSecret: 'secret' }, new Date('2026-10-17T00:00:00Z')));
    const date = url.searchParams.get('date');
    const signature = createHmac('sha256', 'secret').update(`host: ${url.host}\ndate: ${date}\nGET ${url.pathname} HTTP/1.1`).digest('base64');
    expect(Buffer.from(url.searchParams.get('authorization')!, 'base64').toString()).toContain(`signature="${signature}"`);
    expect(url.pathname).toBe('/v1/private/simult_interpretation');
  });
  it('sets first, intermediate and final frame status consistently', () => {
    for (const [seq, last, status] of [[0, false, 0], [1, false, 1], [2, true, 2]] as const) {
      const request = audioRequest('app', Buffer.from([0, 0]), seq, last);
      expect(request.header.status).toBe(status); expect(request.payload.data.status).toBe(status);
      expect(request.parameter !== undefined).toBe(seq === 0);
    }
  });
  it('maps translation revisions to the same timestamp identity', () => {
    const events: ServerEvent[] = [];
    const decoder = new VendorDecoder('session', event => events.push(event));
    for (const final of [0, 1]) decoder.accept(JSON.stringify({ header: { code: 0 }, payload: { streamtrans_results: { text: base64({ src: '你好', dst: 'Hello', wb: 20, we: 900, is_final: final }) } } }));
    expect(events.map(event => 'id' in event && event.id)).toEqual(['t:20', 't:20']);
    expect(vendorError(11200).retryable).toBe(false); expect(vendorError(99999).retryable).toBe(false);
  });
  it('suppresses cloud TTS in local-reading mode while preserving real captions', () => {
    const events: ServerEvent[] = [];
    const decoder = new VendorDecoder('local', event => events.push(event), false);
    decoder.accept(JSON.stringify({ header: { code: 0 }, payload: {
      streamtrans_results: { text: base64({ src: '课堂测试', dst: 'Classroom test.', wb: 10, we: 900, is_final: 1 }) },
      tts_results: { id: '0', seq: 1, status: 1, audio: 'AAA=' },
    } }));
    expect(events).toHaveLength(1); expect(events[0].type).toBe('caption');
  });
});
it('keeps metric samples bounded and reports percentiles without content', () => {
  const metrics = emptyMetrics(); for (let i = 0; i < 1000; i++) sample(metrics.finalLatencyMs, i);
  expect(metrics.finalLatencyMs).toHaveLength(300); expect(summarize(metrics.finalLatencyMs)).toMatchObject({ medianMs: 850, maxMs: 999 });
});
