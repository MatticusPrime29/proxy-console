// Private transport boundary. No provider credentials or inference keys live here.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const inferencePaths = new Set([
  '/v1/models', '/v1/responses', '/v1/responses/compact', '/v1/alpha/search',
  '/v1/chat/completions', '/v1/completions', '/v1/messages', '/v1/messages/count_tokens',
]);

export function pathAllowed(raw, admin = false) {
  // Reject ambiguous encodings rather than having two proxies normalize differently.
  const path = raw.split('?')[0];
  if (/[\\%]/.test(path) || path.includes('//') || path.includes('/.')) return false;
  return admin
    ? path.startsWith('/v8/management/') && path !== '/v8/management/credentials/download'
    : inferencePaths.has(path) || /^\/v1\/models\/[A-Za-z0-9._:-]+$/.test(path);
}

function headersFor(headers, upgrade = false) {
  const result = { ...headers, host: '127.0.0.1:8317' };
  const hop = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailer', 'transfer-encoding', 'upgrade',
    ...(headers.connection || '').split(',').map((v) => v.trim().toLowerCase())];
  for (const key of Object.keys(result)) {
    if (hop.includes(key) || key.startsWith('x-forwarded-') || key.startsWith('tailscale-') ||
        key === 'forwarded' || key === 'x-real-ip') delete result[key];
  }
  if (upgrade) { result.connection = 'Upgrade'; result.upgrade = 'websocket'; }
  return result;
}

export function createGateway({ admin = false, secret = '', html = '', origin = '', upstreamPort = 8317 } = {}) {
  const authenticated = (req) => {
    const supplied = Buffer.from(req.headers.authorization || '');
    const expected = Buffer.from(`Bearer ${secret}`);
    return secret.length >= 32 && supplied.length === expected.length && timingSafeEqual(supplied, expected);
  };
  const reject = (res, code, message) => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: message }));
  };
  const server = http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    if (admin && req.method === 'GET' && ['/', '/management.html'].includes(req.url)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html); return;
    }
    if (!pathAllowed(req.url, admin)) return reject(res, 404, 'Route not available on this endpoint');
    if (admin) {
      if (req.headers.origin && req.headers.origin !== origin) return reject(res, 403, 'Origin rejected');
      if (!authenticated(req)) return reject(res, 401, 'Console management key required');
    }
    const upstream = http.request({ hostname: '127.0.0.1', port: upstreamPort,
      method: req.method, path: req.url, headers: headersFor(req.headers) }, (response) => {
      const headers = headersFor(response.headers);
      delete headers.host;
      // Never permit cross-origin browser access through the admin boundary.
      for (const name of Object.keys(headers)) if (name.startsWith('access-control-')) delete headers[name];
      res.writeHead(response.statusCode, headers);
      response.pipe(res);
    });
    upstream.on('error', () => {
      if (!res.headersSent) reject(res, 502, 'Home proxy unavailable');
      else res.destroy();
    });
    req.on('aborted', () => upstream.destroy());
    res.on('close', () => { if (!res.writableEnded) upstream.destroy(); });
    req.pipe(upstream);
  });
  // Streaming requests and model WebSockets must not inherit short proxy timeouts.
  server.requestTimeout = 0;
  server.on('upgrade', (req, socket, head) => {
    if (admin || req.url.split('?')[0] !== '/v1/responses' || !pathAllowed(req.url) ||
        req.headers.upgrade?.toLowerCase() !== 'websocket') {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); return;
    }
    const upstream = http.request({ hostname: '127.0.0.1', port: upstreamPort,
      path: req.url, headers: headersFor(req.headers, true) });
    upstream.on('upgrade', (response, peer, upstreamHead) => {
      const lines = Object.entries(response.headers).map(([k, v]) => `${k}: ${v}`);
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${lines.join('\r\n')}\r\n\r\n`);
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) peer.write(head);
      socket.pipe(peer).pipe(socket);
      peer.on('error', () => socket.destroy());
      socket.on('error', () => peer.destroy());
      socket.on('close', () => peer.destroy());
      peer.on('close', () => socket.destroy());
    });
    upstream.on('response', (response) => {
      // Preserve authentication failures, never turn a failed handshake into a 101.
      socket.write(`HTTP/1.1 ${response.statusCode} Rejected\r\nConnection: close\r\n\r\n`);
      response.pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
    upstream.end();
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2];
  if (!['admin', 'inference'].includes(mode)) throw new Error('Use admin or inference');
  const admin = mode === 'admin';
  const secret = admin ? readFileSync(process.env.CONSOLE_KEY_FILE, 'utf8').trim() : '';
  if (admin && (secret.length < 32 || !process.env.CONSOLE_ORIGIN?.startsWith('https://'))) {
    throw new Error('Private HTTPS origin and a separate strong management key are required');
  }
  const html = admin ? readFileSync(new URL('./management.html', import.meta.url)) : '';
  createGateway({ admin, secret, html, origin: process.env.CONSOLE_ORIGIN })
    .listen(admin ? 8318 : 8316, '127.0.0.1');
}
