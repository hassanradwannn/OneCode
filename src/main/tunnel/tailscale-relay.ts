/** Tailscale preserves Host. Keep MCP's loopback guard intact at this transport boundary. */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface TailscaleRelay { origin: string; stop(): Promise<void> }
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

function headers(source: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const banned = new Set([...HOP, ...(source.connection ?? '').split(',').map(value => value.trim().toLowerCase())]);
  return Object.fromEntries(Object.entries(source).filter(([key]) => !banned.has(key.toLowerCase())));
}

export async function createTailscaleRelay(origin: string, publicHost: string): Promise<TailscaleRelay> {
  const target = new URL(origin);
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || !target.port || target.pathname !== '/' || target.username || target.password) {
    throw new Error('OneCode Funnel relay requires its current loopback MCP origin.');
  }
  const expectedHosts = new Set([publicHost, publicHost.replace(/:443$/, '')]);
  const server = http.createServer((req, res) => {
    // No arbitrary local-service proxy, redirects, credentials or non-MCP routes.
    if (!expectedHosts.has((req.headers.host ?? '').toLowerCase()) ||
        !/^\/mcp\/(?:core|desktop|plugins)\/[A-Za-z0-9_-]{43}(?:\/\.well-known\/oauth-protected-resource)?(?:\?[^\r\n]*)?$/.test(req.url ?? '') ||
        !['GET', 'POST', 'DELETE', 'OPTIONS'].includes(req.method ?? '')) {
      res.writeHead(404).end(); return;
    }
    const outgoing = http.request({
      hostname: '127.0.0.1', port: Number(target.port), method: req.method, path: req.url,
      headers: { ...headers(req.headers), host: target.host }
    }, response => {
      res.writeHead(response.statusCode ?? 502, headers(response.headers));
      response.pipe(res);
    });
    outgoing.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.on('aborted', () => outgoing.destroy());
    res.on('close', () => { if (!res.writableEnded) outgoing.destroy(); });
    req.pipe(outgoing);
  });
  server.on('connect', (_req, socket) => socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'));
  server.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    stop: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); })
  };
}
