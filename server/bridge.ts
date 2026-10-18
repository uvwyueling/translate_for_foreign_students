import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import type { Mode, ServerEvent } from '../shared/protocol.js';
import { signedUrl, VendorDecoder, type Credentials } from './xfyun.js';
import { PausePipeline } from './pause-pipeline.js';
import { PcmUplink } from './pcm-uplink.js';
import { createProviderSocket, providerConnectionFailure, providerConnectionTimeout } from './provider-connection.js';

const EXAMPLES = [
  ['同学们好，今天我们讨论如何提出一个清晰的问题。', 'Hello everyone. Today we will discuss how to ask a clear question.'],
  ['首先观察现象，然后给出你的假设。', 'First, observe what happens. Then, explain your hypothesis.'],
  ['请看屏幕上的例子，思考其中的因果关系。', 'Look at the example on the screen and think about cause and effect.'],
  ['接下来，我们用一个简单的实验检验这个想法。', 'Next, we will test this idea with a simple experiment.'],
];
export interface BridgeConfig { credentials?: Credentials; accessToken?: string; origin?: string; maxSeconds?: number }
export function readConfig(): BridgeConfig {
  const { XFYUN_APP_ID: appId, XFYUN_API_KEY: apiKey, XFYUN_API_SECRET: apiSecret } = process.env;
  return {
    credentials: appId && apiKey && apiSecret ? { appId, apiKey, apiSecret } : undefined,
    accessToken: process.env.CLASSROOM_ACCESS_TOKEN,
    origin: process.env.ALLOWED_ORIGIN,
    maxSeconds: Math.max(10, Math.min(250, Number(process.env.SESSION_MAX_SECONDS) || 240)),
  };
}
export function health(config: BridgeConfig) {
  return { ok: true, liveConfigured: !!config.credentials && !!config.accessToken, mockAvailable: true, sessionMaxSeconds: config.maxSeconds ?? 240,
    runtimeRegion: process.env.VERCEL_REGION ?? 'local', revision: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) ?? '' };
}
export function tokenMatches(value: unknown, expected?: string): boolean {
  if (typeof value !== 'string' || !expected) return false;
  const a = Buffer.from(value), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function allowedOrigin(request: IncomingMessage, configured?: string): boolean {
  const origin = request.headers.origin;
  if (!origin) return false;
  if (configured) return origin === configured;
  try { return new URL(origin).host === request.headers.host; } catch { return false; }
}
export function attachBridge(wss: WebSocketServer, config: BridgeConfig) {
  wss.on('connection', socket => {
    let sessionId = '', mode: Mode = 'mock', started = false, disposed = false;
    let upstream: WebSocket | undefined;
    let decoder: VendorDecoder | undefined;
    let uplink: PcmUplink | undefined;
    let pausePipeline: PausePipeline | undefined;
    let sampleBytes = 0, ready = false, mockIndex = 0;
    let lastPing = Date.now(), lastAudio = Date.now();
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const after = (fn: () => void, ms: number) => { const timer = setTimeout(() => { timers.delete(timer); if (!disposed) fn(); }, ms); timers.add(timer); };
    const emit = (event: ServerEvent) => {
      if (disposed || socket.readyState !== WebSocket.OPEN) return;
      if (socket.bufferedAmount > 1_000_000) { socket.close(1013, 'Slow client'); return; }
      socket.send(JSON.stringify(event));
    };
    const close = () => {
      if (disposed) return;
      disposed = true;
      for (const t of timers) clearTimeout(t);
      clearInterval(watchdog);
      pausePipeline?.stop();
      uplink?.stop(true);
      upstream?.close();
      if (upstream && upstream.readyState !== WebSocket.CLOSED) { const u = upstream; const t = setTimeout(() => u.terminate(), 1000); t.unref(); }
      socket.close();
    };
    const fail = (code: string, message: string, retryable: boolean) => { emit({ type: 'error', code, message, retryable }); close(); };
    const watchdog = setInterval(() => {
      if (Date.now() - lastPing > 20000) return fail('HEARTBEAT_TIMEOUT', '连接没有响应，正在重新建立连接。', true);
      if (ready && mode === 'live' && Date.now() - lastAudio > 12000) return fail('NO_AUDIO', '没有收到麦克风音频，请检查设备后手动重试。', false);
      try { decoder?.checkAudioTimeout(); pausePipeline?.checkAudioTimeout(); } catch { fail('AUDIO_SEQUENCE_TIMEOUT', '英文语音存在缺片，请手动重试。', false); }
    }, 5000);
    after(() => { if (!started) fail('START_TIMEOUT', '连接等待超时，请重试。', true); }, 8000);
    socket.on('error', close);
    socket.on('close', close);
    socket.on('message', (raw, binary) => {
      if (disposed) return;
      if (binary) {
        if (!ready) return;
        const audio = Buffer.from(raw as Buffer);
        if (audio.length !== 1280) return fail('PCM_FORMAT', '麦克风音频格式异常，请重新开始。', false);
        lastAudio = Date.now();
        // 丢弃断连区间，且拒绝快于实时速率的大量上传。
        sampleBytes += audio.length;
        if (sampleBytes > (Date.now() - streamStarted + 2000) * 32) return fail('AUDIO_RATE', '音频传输过快，请重新开始。', false);
        if (pausePipeline) { pausePipeline.push(audio); return; }
        if (mode === 'live') uplink?.push(audio);
        return;
      }
      try {
        const message = JSON.parse(raw.toString());
        if (message.type === 'ping') { lastPing = Date.now(); emit({ type: 'pong', at: Number(message.at) }); return; }
        if (message.type === 'stop') { close(); return; }
        if (message.type !== 'start' || started || typeof message.sessionId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(message.sessionId) || !['mock', 'live'].includes(message.mode) || (message.speechMode !== undefined && !['provider', 'local'].includes(message.speechMode)) || (message.segmentation !== undefined && !['continuous', 'pause'].includes(message.segmentation)))
          return fail('INVALID_START', '连接参数异常，请刷新页面。', false);
        started = true;
        sessionId = message.sessionId; mode = message.mode;
        after(() => { emit({ type: 'handoff', sessionId }); close(); }, (config.maxSeconds ?? 240) * 1000);
        if (mode === 'mock') {
          ready = true; streamStarted = Date.now();
          emit({ type: 'ready', sessionId, mode });
          const tick = () => {
            const [zh, en] = EXAMPLES[mockIndex % EXAMPLES.length];
            const index = mockIndex++, id = `mock:${index}`;
            emit({ type: 'recognition', sessionId, text: zh.slice(0, 12), final: false, endMs: 0 });
            after(() => emit({ type: 'caption', sessionId, id, zh, en: en.slice(0, 35), final: false, endMs: 0 }), 450);
            after(() => {
              emit({ type: 'caption', sessionId, id, zh, en, final: true, endMs: 0 });
              emit({ type: 'mock-speech', sessionId, seq: index, text: en });
            }, 1000);
            after(tick, 6500);
          };
          after(tick, 1000);
          return;
        }
        if (!config.credentials || !config.accessToken) return fail('NOT_CONFIGURED', '真实同传尚未配置，请联系项目负责人或使用模拟模式。', false);
        if (!tokenMatches(message.token, config.accessToken)) return fail('UNAUTHORIZED', '课堂口令不正确，请检查后重试。', false);
        if (message.segmentation === 'pause') {
          pausePipeline = new PausePipeline(config.credentials, event => {
            emit('sessionId' in event ? { ...event, sessionId } : event);
            if (event.type === 'error') close();
          }, () => { ready = true; streamStarted = Date.now(); lastAudio = Date.now(); emit({ type: 'ready', sessionId, mode }); }, fail, message.speechMode !== 'local');
          pausePipeline.start(); return;
        }
        let providerFailed = false;
        decoder = new VendorDecoder(sessionId, event => { if (event.type === 'error') providerFailed = true; emit(event); }, message.speechMode !== 'local');
        upstream = createProviderSocket(signedUrl(config.credentials));
        uplink = new PcmUplink(upstream, config.credentials.appId, fail);
        after(() => {
          if (ready) return;
          const failure = providerConnectionTimeout(upstream!);
          fail(failure.code, failure.message, failure.retryable);
        }, 10000);
        upstream.on('open', () => { if (disposed) return; uplink!.start(); ready = true; streamStarted = Date.now(); lastAudio = Date.now(); emit({ type: 'ready', sessionId, mode }); });
        upstream.on('message', data => {
          if (disposed) return;
          try { if (!decoder!.accept(data.toString())) { if (!providerFailed && socket.readyState === WebSocket.OPEN) emit({ type: 'handoff', sessionId }); close(); } }
          catch { fail('PROVIDER_PROTOCOL', '服务返回格式或音频顺序异常，请手动重试；字幕可保留查看。', false); }
        });
        upstream.on('unexpected-response', (_req, response) => {
          response.resume();
          fail(`PROVIDER_HTTP_${response.statusCode}`, [401, 403].includes(response.statusCode ?? 0) ? '服务鉴权失败，请联系项目负责人检查凭证和服务器时间。' : '同传服务连接被拒绝，请联系项目负责人检查服务权限。', false);
        });
        upstream.on('error', error => {
          if (disposed) return;
          const failure = providerConnectionFailure(upstream!, error);
          fail(failure.code, failure.message, failure.retryable);
        });
        upstream.on('close', () => { if (!disposed) fail('PROVIDER_CLOSED', '同传服务连接已结束，正在重新连接。', true); });
      } catch { fail('INVALID_MESSAGE', '连接消息异常，请重新开始。', false); }
    });
    let streamStarted = Date.now();
  });
}
