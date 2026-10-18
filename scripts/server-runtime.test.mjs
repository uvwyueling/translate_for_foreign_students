// 用普通 Node 加载真正的编译产物，避免 tsx / Vite 隐式补全路径掩盖部署错误。
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import WebSocket from 'ws';
import server from '../.cache/server-runtime/api/server.js';

test('compiled deployment entry serves health and a mock WebSocket session', { timeout: 10000 }, async () => {
  let socket;
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    for (const path of ['/api/health', '/api/server']) {
      const response = await fetch(origin + path);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).ok, true);
    }
    // 模拟连接不传凭证、不采音，也不会调用讯飞。
    socket = new WebSocket(origin.replace('http:', 'ws:') + '/api/ws', { origin: process.env.ALLOWED_ORIGIN || origin });
    await once(socket, 'open');
    const ready = once(socket, 'message');
    socket.send(JSON.stringify({ type: 'start', sessionId: 'compiled-runtime', mode: 'mock' }));
    assert.equal(JSON.parse((await ready)[0].toString()).type, 'ready');
    const pong = once(socket, 'message');
    socket.send(JSON.stringify({ type: 'ping', at: 123 }));
    assert.deepEqual(JSON.parse((await pong)[0].toString()), { type: 'pong', at: 123 });
    const closed = once(socket, 'close');
    socket.send(JSON.stringify({ type: 'stop' }));
    await closed;
  } finally {
    socket?.terminate();
    await new Promise(resolve => server.close(resolve));
  }
});
