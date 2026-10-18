import { existsSync } from 'node:fs';
import { createApp } from './app';
if (existsSync('.env')) process.loadEnvFile('.env');
const { server } = createApp(undefined, true);
server.listen(Number(process.env.PORT) || 3001, '127.0.0.1', () => console.info('课堂服务已启动：http://127.0.0.1:' + (process.env.PORT || 3001)));
