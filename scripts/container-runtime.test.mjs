// 验证真正的容器编译入口、静态网页和 WebSocket；不调用讯飞。
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import WebSocket from 'ws';

test('compiled container binds externally and serves the webpage, projection, assets and mock transport', { timeout: 10000 }, async () => {
  const overrides = { PORT: '0', RUNTIME_REGION: 'ap-shanghai', APP_REVISION: '1234567890abcdef',
    XFYUN_APP_ID: 'test-app', XFYUN_API_KEY: 'test-key', XFYUN_API_SECRET: 'test-secret',
    CLASSROOM_ACCESS_TOKEN: 'test-classroom-token', ALLOWED_ORIGIN: '' };
  const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  let server, socket;
  try {
    server = (await import('../.cache/container-runtime/server/container.js')).default;
    if (!server.listening) await once(server, 'listening');
    assert.equal(server.address().address, '0.0.0.0');
    const origin = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(origin + '/api/health');
    assert.equal(response.status, 200);
    const health = await response.json();
    assert.equal(health.ok, true);
    assert.equal(health.liveConfigured, true);
    assert.equal(health.runtimeRegion, 'ap-shanghai');
    assert.equal(health.revision, '1234567890ab');
    assert.equal('instanceId' in health, false);
    for (const value of ['test-key', 'test-secret', 'test-classroom-token']) assert.equal(JSON.stringify(health).includes(value), false);

    const home = await fetch(origin + '/');
    assert.equal(home.status, 200);
    assert.match(home.headers.get('content-type'), /text\/html/);
    const html = await home.text();
    assert.equal(await (await fetch(origin + '/subtitles')).text(), html);
    const entry = html.match(/<script[^>]*\bsrc="([^"]+)"/);
    assert.ok(entry, 'built page must reference a JavaScript entry');
    const script = await fetch(new URL(entry[1], origin));
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type'), /javascript/);

    socket = new WebSocket(origin.replace('http:', 'ws:') + '/api/ws', { origin });
    await once(socket, 'open');
    const ready = once(socket, 'message');
    socket.send(JSON.stringify({ type: 'start', sessionId: 'container-runtime', mode: 'mock' }));
    assert.equal(JSON.parse((await ready)[0].toString()).type, 'ready');
    const pong = once(socket, 'message');
    socket.send(JSON.stringify({ type: 'ping', at: 456 }));
    assert.deepEqual(JSON.parse((await pong)[0].toString()), { type: 'pong', at: 456 });
    const closed = once(socket, 'close');
    socket.send(JSON.stringify({ type: 'stop' }));
    await closed;
  } finally {
    socket?.terminate();
    if (server) await new Promise(resolve => server.close(resolve));
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
