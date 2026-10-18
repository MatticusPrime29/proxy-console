import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { createGateway, pathAllowed } from './gateway.mjs';

const listen = async (server) => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port; };
const secret = 'fixture-management-key-not-real-123456789';

test('inference denies all admin paths, encoded and normalized bypasses', () => {
  for (const path of ['/v8/management/config', '/management.html', '/v0/management/config',
    '/v1/../v8/management/config', '/v1/%2e%2e/v8/management/config', '//v1/responses',
    '/v1/responses/../config', '/v1/responses%2f..', '/v1\\responses']) {
    assert.equal(pathAllowed(path), false, path);
  }
  assert.equal(pathAllowed('/v1/responses?stream=true'), true);
  assert.equal(pathAllowed('/v1/alpha/search'), true);
  assert.equal(pathAllowed('/v1/models/gpt-6.1-sol'), true);
  assert.equal(pathAllowed('/v1/models/../../v8/management/config'), false);
  assert.equal(pathAllowed('/v8/management/credentials/download?name=a', true), false);
});

test('admin requires independent bearer key and same-origin; streams pass through unchanged', async (t) => {
  const upstream = http.createServer((req, res) => {
    assert.equal(req.headers['x-forwarded-for'], undefined);
    assert.equal(req.headers['tailscale-user-login'], undefined);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-CPA-VERSION': 'fixture' });
    res.write('data: first\n\n'); setTimeout(() => res.end('data: done\n\n'), 10);
  });
  const upstreamPort = await listen(upstream);
  const admin = createGateway({ admin: true, secret, html: '<title>Console</title>', origin: 'https://console.fixture', upstreamPort });
  const inference = createGateway({ upstreamPort });
  const adminPort = await listen(admin), inferencePort = await listen(inference);
  t.after(() => { admin.closeAllConnections(); inference.closeAllConnections(); upstream.closeAllConnections(); admin.close(); inference.close(); upstream.close(); });
  const call = (path, headers = {}) => fetch(`http://127.0.0.1:${adminPort}${path}`, { headers });
  assert.equal((await call('/v8/management/config')).status, 401);
  assert.equal((await call('/v8/management/config', { Authorization: 'Bearer worker-key' })).status, 401);
  assert.equal((await call('/v8/management/config', { Authorization: `Bearer ${secret}`, Origin: 'https://evil.fixture' })).status, 403);
  assert.equal((await call('/v8/management/credentials/download', { Authorization: `Bearer ${secret}` })).status, 404);
  assert.equal((await call('/v1/responses', { Authorization: `Bearer ${secret}` })).status, 404);
  const good = await call('/v8/management/credentials', { Authorization: `Bearer ${secret}`, 'X-Forwarded-For': '1.2.3.4', 'Tailscale-User-Login': 'forged' });
  assert.equal(good.status, 200); assert.equal(good.headers.get('x-cpa-version'), 'fixture');
  assert.equal(await good.text(), 'data: first\n\ndata: done\n\n');
  const streamed = await fetch(`http://127.0.0.1:${inferencePort}/v1/responses`, { method: 'POST', body: '{}' });
  assert.equal(await streamed.text(), 'data: first\n\ndata: done\n\n');
});

test('WebSocket handshake, initial bytes, and bidirectional data survive the inference filter', async (t) => {
  const peers = new Set();
  const upstream = http.createServer();
  upstream.on('connection', (socket) => peers.add(socket));
  upstream.on('upgrade', (req, socket, head) => {
    assert.equal(req.headers.authorization, 'Bearer worker-fixture');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nWELCOME');
    if (head.length) socket.write(head);
    socket.on('data', (chunk) => socket.write(chunk));
  });
  const upstreamPort = await listen(upstream);
  const gateway = createGateway({ upstreamPort });
  const port = await listen(gateway);
  const socket = net.connect(port, '127.0.0.1');
  t.after(() => { socket.destroy(); for (const peer of peers) peer.destroy(); gateway.close(); upstream.close(); });
  await once(socket, 'connect');
  let received = '';
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket timeout')), 2000);
    socket.on('data', (data) => { received += data; if (received.includes('PING')) { clearTimeout(timer); resolve(); } });
  });
  socket.write('GET /v1/responses HTTP/1.1\r\nHost: fixture\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nAuthorization: Bearer worker-fixture\r\n\r\nPING');
  await done;
  assert.match(received, /101 Switching Protocols/); assert.match(received, /WELCOME/);
});
