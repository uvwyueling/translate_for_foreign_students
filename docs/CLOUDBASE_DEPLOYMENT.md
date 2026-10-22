# CloudBase 国内节点对照部署

目标是用腾讯云上海节点验证新的网络路径。容器同时提供测试网页和音频后端，通过新 HTTPS 地址完成同源测试。此改动没有证明云端到讯飞已经恢复，也没有自动创建或购买任何云资源。

## 项目准备

仓库根目录已提供 `Dockerfile` 和 `.dockerignore`。镜像使用 Node.js 24，构建网页与后端 JavaScript；运行镜像仅带生产依赖，不需要 `tsx` 或 TypeScript 编译器。容器入口为 `server/container.ts` 的编译产物，监听 `0.0.0.0:8080`，直接提供首页、`/subtitles`、静态资源、`/api/health` 和 `/api/ws`。

`.dockerignore` 按允许列表上传构建源码，不包含本机 `.env`、密钥文件、Git 历史、日志、录音、运行报告及依赖缓存。讯飞凭证与课堂口令只在腾讯云控制台的运行环境变量中填写。

部署前先提交并推送这些文件到所选的 GitHub 分支；控制台读取 GitHub 上的代码，无法使用电脑里尚未推送的 Dockerfile。

## 按用户提供的 Git 部署页面填写

| 配置项 | 首次短测配置 |
| --- | --- |
| Git 仓库 | `uvwyueling/translate_for_foreign_students` |
| 分支 | `main` |
| 启用自动部署 | 开启；后续推送会触发部署 |
| 服务名称 | `translation-tencent` |
| 访问端口 | 保持页面的 `80`；公网使用平台提供的 HTTPS 地址 |
| 服务端口 | **`8080`**，与 Dockerfile 和运行时一致 |
| 目标目录 | `.`，表示仓库根目录；留空的默认值也是根目录 |
| Dockerfile 文件 | **有** |
| Dockerfile 名称 | `Dockerfile` |
| API Key 设置 | 关闭。这是腾讯云资源权限注入，不是讯飞 API Key |
| 时区设置 | 保持关闭；讯飞签名使用 UTC，不依赖本地时区 |
| 公网默认域名 | 开启，供浏览器访问 |
| 内网默认地址 | 关闭 |
| 容器规格 | 首次短测保留截图的 **1 核 / 2 G**，不代表长期费用已估算 |
| 日志采集路径 | `stdout` |
| 存储挂载 | 关闭；当前项目不需要持久化音频或课堂正文 |
| 私有网络 | 关闭；首次对照不配置 VPC 或额外出口资源 |
| 实例控制模式 | 自动启停实例 |
| 运行模式 | 始终自动扩缩容 |
| 实例副本数 | 最小 **0**，最大 **1**，用于单实例短测 |
| 扩缩容条件 | 暂不添加额外规则 |
| CMD / ENTRYPOINT | **都留空**，使用 Dockerfile 中的启动命令；不要填 `npm start` |

CloudBase 官方文档确认需要[监听 `0.0.0.0` 且端口匹配](https://docs.cloudbase.net/run/faq/deploy)，并说明[Git 部署、目标目录及启动命令覆盖规则](https://docs.cloudbase.net/run/deploy/deploy/introduce)。首次截图只证明体验版显示了创建表单，实际创建权限、可用资源和费用提示仍以提交时的控制台结果为准。

## 环境变量

| key | value |
| --- | --- |
| `PORT` | `8080` |
| `RUNTIME_REGION` | `ap-shanghai`，须与实际环境地域一致 |
| `SESSION_MAX_SECONDS` | `240`，保留已有主动交接时长，先不调整长课行为 |
| `XFYUN_APP_ID` | 当前讯飞应用的 APPID，与此前测试的应用一致 |
| `XFYUN_API_KEY` | 同一讯飞应用的 APIKey |
| `XFYUN_API_SECRET` | 同一讯飞应用的 APISecret |
| `CLASSROOM_ACCESS_TOKEN` | 教师页面输入的课堂口令，可沿用现有值 |

`ALLOWED_ORIGIN` 首次可以不添加：现有后端会要求浏览器来源的主机名与请求 Host 一致。若反向代理改写 Host，出现网页可打开但 WebSocket 返回 403，可将此变量明确设置为实际的腾讯云 HTTPS 网页地址（不带路径、不带末尾斜线），然后重新部署；不使用 `*`，不填旧 Vercel 地址。若只把后端迁移而继续使用 Vercel 网页，需要另外修改前端连接地址并配置相应来源，本轮采用新地址整站对照。

`APP_REVISION` 可选，填写本次实际部署的 Git 提交标识；未设置时容器健康检查的 `revision` 为空，不编造提交标识。`NODE_ENV=production` 已在 Dockerfile 中设置。

数据库、云存储、CloudBase SDK 和腾讯云 API Key 注入均不是本轮音频中转所需条件。不要将讯飞凭证放进源码、构建参数或 `VITE_` 变量。

## 部署后按顺序验证

1. 查看构建和启动日志：构建结束，启动日志为“课堂容器服务已启动”，端口 `8080`。若镜像拉取或依赖下载失败，需要按实际构建错误处理，不能算作讯飞网络验证结果。
2. 打开服务实际生成的 **HTTPS** 地址加 `/api/health`，确认 `ok: true`、`liveConfigured: true`、`runtimeRegion: ap-shanghai`。这只验证启动和配置存在，不证明讯飞已连接。默认域名与访问方式见[官方说明](https://docs.cloudbase.net/run/develop/access/client)。
3. 在同一个腾讯云地址打开教师网页，重新输入课堂口令。先做 15–30 秒模拟测试，确认采集和网页发送帧数增长。
4. 切换真实模式，先等“课堂进行中”；连接未建立时无需朗读。连接成功后读原有四句语料并继续测试至少两分钟，核对真实字幕、英文音频及新增发送诊断。
5. 若失败，保存本次 `provider_connection_failed` 或 `provider_uplink_failed` 日志及运行数据。要以腾讯云的实测结果判断新网络路径，不能以本机成功、构建成功或模拟字幕代替。

现有客户端运行期间每秒发送心跳并会重连，满足云托管[定期发送空闲 WebSocket 心跳的建议](https://docs.cloudbase.net/run/faq/gw)；仍需实测实际网关时限及 240 秒主动交接，不能视为长课验收已通过。

## 本地验证方式

```sh
npm run test:container-runtime
```

此检查先构建，再用普通 Node 启动真正的容器入口，检查对外监听地址、健康信息、网页 / 投影页面、编译资源和模拟 WebSocket 心跳，不发送音频、不调用讯飞。它需要本机测试端口权限，不等于 Linux Docker 镜像已构建或云端部署已成功。

本轮本地构建、99 项 Vitest 测试、原 Vercel 编译入口检查及新容器编译入口检查均通过。已获得本机端口测试权限，因此也覆盖了此前因端口权限限制未运行的检查。本机没有 Docker，未构建或运行完整 Linux 镜像；尚未推送、创建腾讯云服务或验证腾讯云到讯飞的真实连接。
