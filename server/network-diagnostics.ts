import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';

// 仅用于比较同一进程的连接结果，不是用户、账号或平台实例标识。
const instanceId = randomUUID();
export function runtimeDiagnostics() {
  return { runtimeRegion: process.env.VERCEL_REGION ?? 'local', revision: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) ?? '', instanceId };
}

/** 只保留固定服务目标的有效 IP，忽略其他字符串并限制诊断大小。 */
export function recordIp(addresses: string[], address: unknown) {
  if (typeof address === 'string' && isIP(address) && addresses.length < 16 && !addresses.includes(address)) addresses.push(address);
}
