import { createApp } from './app.js';

// 容器直接提供网页与 WebSocket，浏览器使用同一个 HTTPS 域名。
// 生产配置仅从运行时环境变量读取，不加载开发电脑上的 .env。
const port = Number(process.env.PORT || 8080);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be an integer between 0 and 65535');
const { server } = createApp(undefined, true);
server.listen(port, '0.0.0.0', () => {
  const address = server.address();
  console.info('课堂容器服务已启动', { host: '0.0.0.0', port: typeof address === 'object' && address ? address.port : port });
});
export default server;
