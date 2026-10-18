import { createConnection, type Socket, type TcpNetConnectOpts } from 'node:net';

type Target = { id: string; host: string; port: number; family: 0 | 4 };
type Result = Target & { ok: boolean; elapsedMs: number; resolvedFamilies: number[]; errorCode: string | null };
const SAFE_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EACCES', 'EPERM', 'ERR_SOCKET_CONNECTION_TIMEOUT']);
const targets: Target[] = [
  { id: 'xfyun-default', host: 'ws-api.xf-yun.com', port: 443, family: 0 },
  { id: 'xfyun-ipv4', host: 'ws-api.xf-yun.com', port: 443, family: 4 },
  { id: 'xfyun-website-ipv4', host: 'www.xfyun.cn', port: 443, family: 4 },
  { id: 'control-vercel-ipv4', host: 'vercel.com', port: 443, family: 4 },
];

/** 固定目标的短时 TCP 对照，不发送 TLS、HTTP、凭证或音频载荷。 */
export function checkTcp(target: Target, timeoutMs = 4000, makeSocket: (options: TcpNetConnectOpts) => Socket = createConnection): Promise<Result> {
  return new Promise(resolve => {
    const startedAt = Date.now(), resolvedFamilies: number[] = [];
    let socket: Socket | undefined, done = false;
    const finish = (ok: boolean, errorCode: string | null) => {
      if (done) return;
      done = true; clearTimeout(timer); socket?.destroy();
      resolve({ ...target, ok, elapsedMs: Math.max(0, Date.now() - startedAt), resolvedFamilies, errorCode });
    };
    const timer = setTimeout(() => finish(false, 'TIMEOUT'), timeoutMs);
    const failed = (error: unknown) => {
      const code = (error as { code?: unknown } | null)?.code;
      finish(false, typeof code === 'string' && SAFE_CODES.has(code) ? code : 'UNKNOWN');
    };
    try {
      socket = makeSocket({ host: target.host, port: target.port, ...(target.family === 4 ? { family: 4 } : {}) });
      socket.on('lookup', (error, _address, family) => {
        if (!done && !error && (family === 4 || family === 6) && !resolvedFamilies.includes(family)) resolvedFamilies.push(family);
      });
      socket.once('connect', () => finish(true, null));
      socket.once('error', failed);
    } catch (error) { failed(error); }
  });
}
export async function runNetworkCheck() {
  return {
    runtimeRegion: process.env.VERCEL_REGION ?? 'local', revision: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) ?? '',
    checks: await Promise.all(targets.map(target => checkTcp(target))),
  };
}
