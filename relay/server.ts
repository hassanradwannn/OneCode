import http from 'node:http';
import https from 'node:https';
import type { Socket } from 'node:net';
import type { TlsOptions } from 'node:tls';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  parseRelayOrigin, relayDigest, relayPublicOrigin, RELAY_CHANNEL, RELAY_DIGEST, RELAY_HEALTH,
  RELAY_KEY, RELAY_MCP_METADATA, RELAY_MCP_PATH, RELAY_STREAM, RELAY_UPGRADE
} from '../src/shared/relay-protocol.ts';
import type { RelaySurface } from '../src/shared/relay-protocol.ts';

const MAX_BODY = 24 * 1024 * 1024;
const MAX_ROUTE_REQUESTS = 32;
const MAX_REQUESTS = 512;
const CHANNEL_HEARTBEAT = 10_000;
const STREAM_WAIT = 8_000;
const STREAM_IDLE = 90_000;
const PROXY_HEADERS = new Set([
  'accept', 'accept-encoding', 'authorization', 'content-length', 'content-type', 'if-none-match', 'last-event-id',
  'mcp-protocol-version', 'mcp-session-id', 'origin', 'x-onecode-remote', 'x-request-id', 'x-local-tunnel-probe', 'x-onecode-relay-check'
]);
const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
type Route = { digest: string; surface: RelaySurface; host: string; channel?: Channel };
type Channel = { response: http.ServerResponse; flights: Set<Flight> };
type Flight = { channel: Channel; route: Route; finish(): void; attach(socket: Socket): void };

function allowed(surface: RelaySurface, method: string, path: string): boolean {
  const pathname = path.split('?', 1)[0]!;
  if (surface === 'mcp') {
    if (pathname.startsWith(RELAY_MCP_METADATA)) return method === 'GET' && RELAY_MCP_PATH.test(pathname.slice(RELAY_MCP_METADATA.length));
    return ['GET', 'POST', 'OPTIONS', 'DELETE'].includes(method) && RELAY_MCP_PATH.test(pathname);
  }
  if (pathname.startsWith('/api/')) return (method === 'GET' || method === 'POST') && /^\/api\/[0-9a-z/.-]+$/i.test(pathname);
  return method === 'GET' && (pathname === RELAY_HEALTH || /^\/(?:index\.html|assets\/[\w.-]+|preview\/[a-f0-9-]{36})?$/.test(pathname));
}

function connectionHeaders(headers: http.IncomingHttpHeaders): Set<string> {
  return new Set((headers.connection ?? '').split(',').map(value => value.trim().toLowerCase()));
}

/** The edge publishes two fixed HTTP surfaces. No endpoint provides a general TCP proxy. */
export function createRelayServer(options: { origin: string; digests: string[]; tls: TlsOptions }) {
  const origin = parseRelayOrigin(options.origin);
  const routes = new Map<string, Route>(), controls = new Map<string, Route>(), pending = new Map<string, Flight>();
  let active = 0;
  if (options.digests.length > 4096) throw new Error('Supply at most 4096 enrolled device digests.');
  for (const digest of options.digests) {
    if (!RELAY_DIGEST.test(digest)) throw new Error('Invalid relay enrollment digest.');
    for (const surface of ['mcp', 'remote'] as const) {
      const host = relayPublicOrigin(origin, digest, surface).host;
      if (routes.has(host)) throw new Error('Duplicate relay enrollment.');
      const route: Route = { digest, surface, host };
      routes.set(host, route); controls.set(RELAY_CHANNEL + surface + '/' + digest.slice(0, 24), route);
    }
  }
  function fail(res: http.ServerResponse, status: number): void {
    if (res.destroyed || res.writableEnded) return;
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(status, { 'Cache-Control': 'no-store', Connection: 'close', 'Content-Type': 'application/json' })
      .end(JSON.stringify({ error: status === 401 ? 'connection_required' : 'relay_request_unavailable' }));
  }
  function authorized(req: http.IncomingMessage, route: Route): boolean {
    const key = req.headers.authorization?.slice(7);
    return req.headers.authorization?.startsWith('Bearer ') === true && !!key && RELAY_KEY.test(key) &&
      timingSafeEqual(Buffer.from(relayDigest(key), 'hex'), Buffer.from(route.digest, 'hex'));
  }
  function openChannel(req: http.IncomingMessage, res: http.ServerResponse, path: string): void {
    const route = controls.get(path);
    if (!route || req.method !== 'GET' || req.headers['content-length'] || req.headers['transfer-encoding'] || !authorized(req, route)) {
      fail(res, 404); return;
    }
    // A replacement must prove the same enrollment. Retire the old flights rather
    // than waiting for a half-open connection on the device's previous network.
    route.channel?.response.destroy();
    const channel: Channel = { response: res, flights: new Set() };
    route.channel = channel;
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' });
    res.write('\n');
    const beat = setInterval(() => { if (res.writableLength || !res.write('\n')) res.destroy(); }, CHANNEL_HEARTBEAT);
    res.once('close', () => {
      clearInterval(beat);
      if (route.channel === channel) route.channel = undefined;
      for (const flight of channel.flights) flight.finish();
    });
  }
  const server = https.createServer({
    ...options.tls, minVersion: 'TLSv1.2', maxHeaderSize: 16 * 1024, headersTimeout: 10_000,
    requestTimeout: 45_000, handshakeTimeout: 10_000, keepAliveTimeout: 4_000
  }, (req, res) => {
    const path = req.url ?? '', host = req.headers.host?.toLowerCase() ?? '', method = req.method ?? '';
    if (!path.startsWith('/') || /^\/\//.test(path) || /[\\#]/.test(path) || path.length > 4096) { fail(res, 400); return; }
    if (host === origin.host) { openChannel(req, res, path); return; }
    const route = routes.get(host);
    if (!route || !allowed(route.surface, method, path)) { fail(res, 404); return; }
    if (route.surface === 'remote' && path.startsWith('/api/') &&
        (req.headers['x-onecode-remote'] !== '1' || (method === 'POST' && req.headers.origin !== 'https://' + host) ||
         (req.headers.origin !== undefined && req.headers.origin !== 'https://' + host) ||
         (path !== '/api/connect' && !/^Bearer [A-Za-z0-9_-]{43}$/.test(req.headers.authorization ?? '')))) {
      fail(res, 401); return;
    }
    if (Number(req.headers['content-length']) > MAX_BODY) { fail(res, 413); return; }
    const channel = route.channel;
    if (!channel) { fail(res, 503); return; }
    if (active >= MAX_REQUESTS || channel.flights.size >= MAX_ROUTE_REQUESTS || channel.response.writableLength > 4096) {
      fail(res, 429); return;
    }
    const id = randomBytes(32).toString('base64url');
    let retired = false, socket: Socket | undefined, upstream: http.ClientRequest | undefined;
    const cancel = (): void => { flight.finish(); };
    const wait = setTimeout(cancel, STREAM_WAIT);
    const flight: Flight = {
      channel, route,
      finish() {
        if (retired) return;
        retired = true; clearTimeout(wait); pending.delete(id); channel.flights.delete(flight); active--;
        req.off('aborted', cancel);
        res.off('close', cancel);
        req.unpipe(upstream);
        upstream?.destroy(); socket?.destroy();
        fail(res, 502);
      },
      attach(stream) {
        clearTimeout(wait); socket = stream;
        const excluded = connectionHeaders(req.headers);
        const headers = Object.fromEntries(Object.entries(req.headers).filter(([name]) => PROXY_HEADERS.has(name) && !excluded.has(name)));
        const agent = new http.Agent({ keepAlive: false });
        agent.createConnection = () => stream;
        upstream = http.request({ host, path, method, headers: { ...headers, host, connection: 'close' }, agent }, reply => {
          const excluded = connectionHeaders(reply.headers);
          const safe = Object.fromEntries(Object.entries(reply.headers).filter(([name]) =>
            !HOP_HEADERS.has(name) && !excluded.has(name) && name !== 'set-cookie' && name !== 'location'));
          res.writeHead(reply.statusCode ?? 502, { ...safe, 'Cache-Control': 'no-store', 'Strict-Transport-Security': 'max-age=31536000' });
          reply.once('aborted', cancel); reply.once('error', cancel);
          reply.pipe(res);
        });
        upstream.once('error', cancel);
        upstream.setTimeout(STREAM_IDLE, cancel);
        let uploaded = 0;
        req.on('data', chunk => {
          uploaded += chunk.length;
          if (uploaded <= MAX_BODY || retired) return;
          fail(res, 413); cancel(); req.pause();
        });
        req.pipe(upstream);
      }
    };
    active++; channel.flights.add(flight); pending.set(id, flight);
    req.once('aborted', cancel); res.once('close', cancel); res.once('finish', cancel);
    channel.response.write(JSON.stringify({ id }) + '\n');
  });
  server.maxConnections = 2048;
  server.maxHeadersCount = 48;
  server.on('checkContinue', (_req, res) => fail(res, 417));
  server.on('checkExpectation', (_req, res) => fail(res, 417));
  server.on('connect', (_req, socket) => socket.destroy());
  server.on('upgrade', (req, socket: Socket, head) => {
    socket.on('error', () => socket.destroy());
    const path = req.url ?? '';
    const id = path.startsWith(RELAY_STREAM) ? path.slice(RELAY_STREAM.length) : '';
    const flight = RELAY_KEY.test(id) ? pending.get(id) : undefined;
    if (!flight || !authorized(req, flight.route) || flight.route.channel !== flight.channel ||
        req.headers.host !== origin.host || req.method !== 'GET' || req.headers.upgrade !== RELAY_UPGRADE ||
        req.headers['content-length'] || req.headers['transfer-encoding'] || head.length) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return;
    }
    pending.delete(id);
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: ' + RELAY_UPGRADE + '\r\n\r\n');
    flight.attach(socket);
  });
  return {
    server,
    async stop(): Promise<void> {
      for (const { channel } of routes.values()) channel?.response.destroy();
      await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    }
  };
}
