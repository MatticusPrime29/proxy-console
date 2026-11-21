// Private transport boundary. No provider credentials or inference keys live here.
import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { dirname } from 'node:path';
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

function hashClientKey(headers) {
  const auth = headers.authorization || headers['x-api-key'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : auth.trim();
  if (!token) return null;
  return createHash('sha256').update(token).digest('hex').slice(0, 12);
}

function extractUsageFromJson(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const u = obj.usage || obj.response?.usage || obj.message?.usage;
  if (!u || typeof u !== 'object') return null;
  const input = u.input_tokens ?? u.prompt_tokens ?? null;
  const cached = u.input_tokens_details?.cached_tokens ?? u.cache_read_input_tokens ?? u.prompt_tokens_details?.cached_tokens ?? null;
  const output = u.output_tokens ?? u.completion_tokens ?? null;
  if (input == null && output == null) return null;
  return { input, cached, output };
}

function parseUsageFromResponse(text) {
  if (!text) return null;
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try { return extractUsageFromJson(JSON.parse(trimmed)); } catch { return null; }
  }
  let found = null;
  for (const line of trimmed.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]' || !payload.includes('usage')) continue;
    try {
      const u = extractUsageFromJson(JSON.parse(payload));
      if (u) found = u;
    } catch { /* ignore partial chunk */ }
  }
  return found;
}

async function createTelemetryTap(archiveDbPath) {
  if (!archiveDbPath) return { record() {}, close() {} };
  try {
    mkdirSync(dirname(archiveDbPath), { recursive: true, mode: 0o700 });
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(archiveDbPath, { timeout: 5000 });
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS proxy_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        proxy_kind TEXT NOT NULL DEFAULT 'inference',
        client_hash TEXT,
        client_label TEXT,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        model TEXT,
        status_code INTEGER,
        duration_ms INTEGER,
        ttft_ms INTEGER,
        stream INTEGER NOT NULL DEFAULT 0,
        is_websocket INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER,
        cached_input_tokens INTEGER,
        output_tokens INTEGER,
        bytes_in INTEGER,
        bytes_out INTEGER,
        error TEXT
      );
    `);
    const stmt = db.prepare(`
      INSERT INTO proxy_requests(
        ts, proxy_kind, client_hash, client_label, method, path, model, status_code,
        duration_ms, ttft_ms, stream, is_websocket, input_tokens, cached_input_tokens,
        output_tokens, bytes_in, bytes_out, error
      ) VALUES (?, 'inference', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    return {
      record(entry) {
        try {
          stmt.run(
            new Date().toISOString(),
            entry.clientHash ?? null,
            entry.clientLabel ?? null,
            entry.method,
            entry.path,
            entry.model ?? null,
            entry.statusCode ?? null,
            entry.durationMs ?? null,
            entry.ttftMs ?? null,
            entry.stream ? 1 : 0,
            entry.isWebsocket ? 1 : 0,
            entry.inputTokens ?? null,
            entry.cachedInputTokens ?? null,
            entry.outputTokens ?? null,
            entry.bytesIn ?? 0,
            entry.bytesOut ?? 0,
            entry.error ?? null,
          );
        } catch { /* telemetry must never break inference */ }
      },
      close() {
        try { db.close(); } catch { /* ignore */ }
      },
    };
  } catch {
    return { record() {}, close() {} };
  }
}

export function createGateway({ admin = false, secret = '', html = '', origin = '', upstreamPort = 8317, telemetry = null } = {}) {
  const tap = telemetry || { record() {}, close() {} };
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

    const startedAt = Date.now();
    const cleanPath = req.url.split('?')[0];
    const clientHash = admin ? null : hashClientKey(req.headers);
    let bytesIn = 0;
    let bytesOut = 0;
    let ttftMs = null;
    let reqPreview = '';
    let resTail = '';
    let recorded = false;
    const recordOnce = (statusCode, error = null) => {
      if (admin || recorded) return;
      recorded = true;
      let model = null;
      let stream = false;
      if (reqPreview) {
        try {
          const parsed = JSON.parse(reqPreview);
          if (typeof parsed.model === 'string') model = parsed.model;
          stream = Boolean(parsed.stream);
        } catch {
          const m = reqPreview.match(/"model"\s*:\s*"([^"]+)"/);
          if (m) model = m[1];
          stream = /"stream"\s*:\s*true/.test(reqPreview);
        }
      }
      const usage = parseUsageFromResponse(resTail);
      tap.record({
        clientHash,
        method: req.method,
        path: cleanPath,
        model,
        statusCode,
        durationMs: Date.now() - startedAt,
        ttftMs,
        stream,
        isWebsocket: false,
        inputTokens: usage?.input ?? null,
        cachedInputTokens: usage?.cached ?? null,
        outputTokens: usage?.output ?? null,
        bytesIn,
        bytesOut,
        error,
      });
    };

    const upstream = http.request({ hostname: '127.0.0.1', port: upstreamPort,
      method: req.method, path: req.url, headers: headersFor(req.headers) }, (response) => {
      const headers = headersFor(response.headers);
      delete headers.host;
      // Never permit cross-origin browser access through the admin boundary.
      for (const name of Object.keys(headers)) if (name.startsWith('access-control-')) delete headers[name];
      res.writeHead(response.statusCode, headers);
      response.on('data', (chunk) => {
        if (ttftMs === null) ttftMs = Date.now() - startedAt;
        bytesOut += chunk.length;
        if (!admin) {
          resTail += chunk.toString('utf8');
          if (resTail.length > 65536) resTail = resTail.slice(-32768);
        }
      });
      response.on('end', () => recordOnce(response.statusCode));
      response.pipe(res);
    });
    upstream.on('error', (err) => {
      recordOnce(502, err?.code || 'upstream_error');
      if (!res.headersSent) reject(res, 502, 'Home proxy unavailable');
      else res.destroy();
    });
    req.on('data', (chunk) => {
      bytesIn += chunk.length;
      if (!admin && reqPreview.length < 32768) reqPreview += chunk.toString('utf8', 0, 32768 - reqPreview.length);
    });
    req.on('aborted', () => { recordOnce(499, 'client_aborted'); upstream.destroy(); });
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
    const startedAt = Date.now();
    const clientHash = hashClientKey(req.headers);
    let bytesIn = head.length;
    let bytesOut = 0;
    let statusCode = 502;
    let recorded = false;
    const recordWs = (error = null) => {
      if (recorded) return;
      recorded = true;
      tap.record({
        clientHash,
        method: 'WEBSOCKET',
        path: '/v1/responses',
        statusCode,
        durationMs: Date.now() - startedAt,
        stream: true,
        isWebsocket: true,
        bytesIn,
        bytesOut,
        error,
      });
    };
    const upstream = http.request({ hostname: '127.0.0.1', port: upstreamPort,
      path: req.url, headers: headersFor(req.headers, true) });
    upstream.on('upgrade', (response, peer, upstreamHead) => {
      statusCode = 101;
      const lines = Object.entries(response.headers).map(([k, v]) => `${k}: ${v}`);
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${lines.join('\r\n')}\r\n\r\n`);
      if (upstreamHead.length) { bytesOut += upstreamHead.length; socket.write(upstreamHead); }
      if (head.length) peer.write(head);
      socket.on('data', (chunk) => { bytesIn += chunk.length; });
      peer.on('data', (chunk) => { bytesOut += chunk.length; });
      socket.pipe(peer).pipe(socket);
      peer.on('error', () => { recordWs('peer_error'); socket.destroy(); });
      socket.on('error', () => { recordWs('socket_error'); peer.destroy(); });
      socket.on('close', () => { recordWs(); peer.destroy(); });
      peer.on('close', () => { recordWs(); socket.destroy(); });
    });
    upstream.on('response', (response) => {
      statusCode = response.statusCode || 502;
      recordWs('upgrade_rejected');
      // Preserve authentication failures, never turn a failed handshake into a 101.
      socket.write(`HTTP/1.1 ${response.statusCode} Rejected\r\nConnection: close\r\n\r\n`);
      response.pipe(socket);
    });
    upstream.on('error', (err) => { recordWs(err?.code || 'upstream_error'); socket.destroy(); });
    socket.on('error', () => { recordWs('socket_error'); upstream.destroy(); });
    socket.on('close', () => { recordWs(); upstream.destroy(); });
    upstream.end();
  });
  server.on('close', () => tap.close());
  return server;
}

export { createTelemetryTap, extractUsageFromJson, parseUsageFromResponse };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2];
  if (!['admin', 'inference'].includes(mode)) throw new Error('Use admin or inference');
  const admin = mode === 'admin';
  const secret = admin ? readFileSync(process.env.CONSOLE_KEY_FILE, 'utf8').trim() : '';
  if (admin && (secret.length < 32 || !process.env.CONSOLE_ORIGIN?.startsWith('https://'))) {
    throw new Error('Private HTTPS origin and a separate strong management key are required');
  }
  const html = admin ? readFileSync(new URL('./management.html', import.meta.url)) : '';
  const telemetry = admin ? null : await createTelemetryTap(process.env.ARCHIVE_DB_PATH || '');
  createGateway({ admin, secret, html, origin: process.env.CONSOLE_ORIGIN, telemetry })
    .listen(admin ? 8318 : 8316, '127.0.0.1');
}
