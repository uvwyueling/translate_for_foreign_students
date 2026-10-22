# 讯飞 TCP 连接超时：2026-10-22 排查材料

当前故障发生在 Vercel 香港函数连接讯飞的 TCP 阶段。实际失败连接尚未进入 TLS、WebSocket 鉴权或课堂音频上传。相同地址在本机可连接，云端固定目标对照持续超时；目前需要核查云端出口、途中网络及目标侧访问策略，尚不能确定具体责任方。

## 部署与失败日志

- 应用：`https://translation-eta-ten.vercel.app`
- 课堂 WebSocket：`/api/ws`；函数入口：`api/server.ts`
- 运行区域：`hkg1`；提交：`81b7a3e7dca6`
- 供应商地址：`wss://ws-api.xf-yun.com/v1/private/simult_interpretation`
- 用户提供的原始日志时间：`2026-10-22 05:04:53.148`。该日志的显示时区未另行核实，提交工单时需要确认；下面自动化对照的时间明确为 UTC。

```json
{
  "event": "provider_connection_failed",
  "runtimeRegion": "hkg1",
  "revision": "81b7a3e7dca6",
  "instanceId": "0ff534ca-f418-4e1f-91d3-eb9a118ffdb2",
  "stage": "tcp",
  "networkCode": "UNKNOWN",
  "elapsedMs": 8241,
  "resolvedAddresses": ["120.92.238.203", "120.92.238.23", "120.92.238.30", "120.92.238.24"],
  "attemptedAddresses": ["120.92.238.203", "120.92.238.23", "120.92.238.30", "120.92.238.24"]
}
```

`UNKNOWN` 源于 `ws` 的固定握手超时没有系统错误码，应用没有记录到 TCP `connect` 事件。`attemptedAddresses` 只表示发起过连接尝试，不表示每个地址分别等待了 8241 ms。`instanceId` 为应用模块初始化时生成的随机进程标记，并非 Vercel 平台实例 ID 或外网出口 IP。

## 本机对照：相同四个地址均可建立 TCP

检查结束时间：`2026-10-22T06:37:13.122Z`（北京时间 14:37:13）。直接使用本机网络，未通过测试脚本配置 HTTP 代理。系统或网络层是否另有转发不在本次检测范围内。

本机 DNS 返回的四个 IPv4 与用户云端日志中的地址集合一致，仅顺序不同。每个固定目标只建立 TCP 443 后立即断开，没有发送 TLS、HTTP、讯飞凭证或音频。

| 本机目标 | 结果 | 耗时 | 实际连接地址 |
| --- | --- | --- | --- |
| `ws-api.xf-yun.com:443` | 成功 | 62 ms | `120.92.238.23` |
| `120.92.238.203:443` | 成功 | 60 ms | 同目标 |
| `120.92.238.23:443` | 成功 | 60 ms | 同目标 |
| `120.92.238.30:443` | 成功 | 60 ms | 同目标 |
| `120.92.238.24:443` | 成功 | 60 ms | 同目标 |
| `vercel.com:443` | 成功 | 170 ms | `64.239.109.65` |

IP 直连仅用于一次性 TCP 对照，生产同传仍通过供应商域名调用，未固定供应商 IP。讯飞[官方接口文档](https://www.xfyun.cn/doc/nlp/simultaneous-interpretation/API.html)明确服务器 IP 不固定。

## 云端对照：讯飞相关目标超时，公共对照成功

检查响应时间：`2026-10-22T06:38:23.075Z`（北京时间 14:38:23）。受课堂口令保护的 `POST /api/health?check=network` 返回 HTTP 200，`hkg1`、`81b7a3e7dca6`，进程标记为 `6515c3c4-6e20-4d71-8b74-c7a806b38c2a`。

本机直连应用入口超时，首次代理请求也未成功；随后通过已有本机代理取得上述响应。代理仅承载本机到应用的检查请求，以下四项 TCP 检查实际在 Vercel 函数内并行执行，没有发送 TLS、HTTP、讯飞凭证或音频。

| 云端目标 | 结果 | 耗时 | 解析及尝试的地址 |
| --- | --- | --- | --- |
| 讯飞 API，默认地址选择 | `TIMEOUT` | 4000 ms | `120.92.238.30`、`120.92.238.24`、`120.92.238.203`、`120.92.238.23` |
| 讯飞 API，显式 IPv4 | `TIMEOUT` | 4001 ms | `120.92.238.30` |
| 讯飞官网，IPv4 | `TIMEOUT` | 4001 ms | `42.62.43.219` |
| Vercel 官网，IPv4 | 成功 | 400 ms | `64.239.109.65` |

检查使用独立的 HTTP 请求，未启动课堂或音频发送定时器，也未使用讯飞鉴权参数。其超时可在这一独立检查中复现，因此不能仅靠修改麦克风、音频格式、字幕显示或发送节奏来解释。

## 证据边界与下一步

- 本机成功与云端失败相隔约一分钟，且本机检查每个地址约 60 ms，云端默认检查已尝试同一地址集合。这支持优先排查云端到目标的访问路径；不能证明具体哪一方丢弃了连接，也不能完全排除期间状态变化。
- DNS 返回了与本机相同的地址集合，但没有供应商侧确认；不能仅凭这一点断言 DNS 绝对正确。默认与显式 IPv4 均失败，不支持把强制 IPv4 当作已验证的修复。
- 本次云端进程标记与用户日志不同；标记本身不能识别外网出口 IP，也不足以判断两个请求是否使用不同宿主或网络出口。
- 之前同一项目曾收到真实讯飞字幕和英文音频，说明历史上有成功连接，仍未验证当前版本可稳定运行。此次连接前失败也没有验证发送节奏补丁的真实效果。
- 进一步需要平台侧出口 / 网络流记录，或在另一可控后端网络环境运行同版本对照。更换区域或后端应作为有记录的对照实验，尚未证明能解决问题。

## 可复制给 Vercel 支持的说明

> Our Node.js function in hkg1 intermittently cannot establish outbound TCP connections to ws-api.xf-yun.com:443. The deployment is https://translation-eta-ten.vercel.app, revision 81b7a3e7dca6, function entry api/server.ts (classroom route /api/ws).
>
> At 2026-10-22T06:38:23.075Z, a separate authenticated HTTP diagnostic request ran four parallel TCP-only probes inside the function: ws-api.xf-yun.com with default address selection timed out at 4000 ms after attempting 120.92.238.30, 120.92.238.24, 120.92.238.203 and 120.92.238.23; explicit IPv4 to the first address timed out at 4001 ms; www.xfyun.cn (42.62.43.219) timed out at 4001 ms; vercel.com (64.239.109.65) connected in 400 ms. These probes send no provider credentials or audio and are independent of the classroom WebSocket and audio scheduler.
>
> At 2026-10-22T06:37:13.122Z, each of the four API IP addresses accepted a TCP 443 connection from the local workstation in approximately 60 ms. A real classroom connection also failed before TCP connect after 8241 ms; its raw log and timezone caveat are included above. Previous sessions from this project have successfully returned real translations, so this has not been a permanent failure.
>
> Could you identify the actual egress IP(s) for the diagnostic invocation and check outbound routing / connection filtering or network-flow evidence for these destinations? Please help distinguish function-side egress problems, path loss and destination-side filtering. The application-generated process marker for the diagnostic response is 6515c3c4-6e20-4d71-8b74-c7a806b38c2a; this is NOT a Vercel platform instance ID or egress IP.

## 可复制给讯飞支持的说明

> 我们使用同声传译接口 wss://ws-api.xf-yun.com/v1/private/simult_interpretation。Vercel 香港 hkg1 后端反复在 TCP 连接阶段超时，尚未进入 TLS、WebSocket 鉴权或音频上传。
>
> 明确 UTC 时间的对照记录为 2026-10-22T06:38:23.075Z（北京时间 14:38:23）：云端解析并尝试了 120.92.238.30、120.92.238.24、120.92.238.203、120.92.238.23，4 秒检查超时；显式 IPv4 同样超时；访问官网 www.xfyun.cn 对应 42.62.43.219:443 也超时，但同轮 vercel.com:443 可连接。一分钟前本机逐一连接同样四个 API 地址，均约 60 ms 成功。实际同传连接日志也曾在 8241 ms 后报告 TCP 超时。
>
> 请确认上述 API 域名解析地址是否符合预期，并核查该时段面向香港云服务出口的 TCP 443 接入、网络路径及源地址过滤 / 限流情况。我们正在向云平台核对实际出口 IP；目前没有证据可以直接归因于某一方。请说明还需提供哪些网络信息，以便联合排查。

本材料尚未向任何外部支持人员发送，不含课堂正文、音频、课堂口令、API Key、API Secret 或带签名的 URL。
