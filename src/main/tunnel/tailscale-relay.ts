/** Tailscale preserves Host. Keep MCP's loopback guard intact at this transport boundary. */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { logInfo, logWarn } from '../logger.js';

export interface TailscaleRelay { origin: string; stop(): Promise<void> }
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
const METADATA = '/.well-known/oauth-protected-resource';
const MCP_PATH = /^\/mcp\/(?:core|desktop|plugins)\/[A-Za-z0-9_-]{43}$/;

function headers(source: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const banned = new Set([...HOP, ...(source.connection ?? '').split(',').map(value => value.trim().toLowerCase())]);
  return Object.fromEntries(Object.entries(source).filter(([key]) => !banned.has(key.toLowerCase())));
}

export async function createTailscaleRelay(origin: string, publicHost: string, publicMount = ''): Promise<TailscaleRelay> {
  const target = new URL(origin);
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || !target.port || target.pathname !== '/' || target.username || target.password) {
    throw new Error('OneCode Funnel relay requires its current loopback MCP origin.');
  }
  if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+\.ts\.net:(?:443|8443|10000)$/.test(publicHost) ||
      (publicMount !== '' && !/^\/onecode-[a-f0-9]{32}$/.test(publicMount))) {
    throw new Error('OneCode Funnel relay requires its validated public hostname and owned mount.');
  }
  const expectedHosts = new Set([publicHost, publicHost.replace(/:443$/, '')]);
  let diagnosticAt = Date.now(), diagnosticCount = 0;
  const diagnostic = (message: string, warn = false): void => {
    if (Date.now() - diagnosticAt >= 60_000) { diagnosticAt = Date.now(); diagnosticCount = 0; }
    if (diagnosticCount++ >= 20) return;
    (warn ? logWarn : logInfo)(message);
  };
  const server = http.createServer((req, res) => {
    const startedAt = Date.now();
    const path = (req.url ?? '').split('?')[0] ?? '';
    const metadataPath = path.startsWith(METADATA) ? path.slice(METADATA.length) : null;
    const family = MCP_PATH.test(path) ? 'mcp' : metadataPath !== null && MCP_PATH.test(metadataPath) ? 'metadata' : 'unmatched';
    let incompleteReported = false;
    const incomplete = (): void => {
      if (!incompleteReported) {
        incompleteReported = true;
        diagnostic(`OneCode Funnel response closed before completion surface=${family} elapsedMs=${Date.now() - startedAt}`, true);
      }
      if (!res.destroyed) res.destroy();
    };
    res.once('finish', () => {
      const method = ['GET', 'POST', 'DELETE', 'OPTIONS', 'HEAD'].includes(req.method ?? '') ? req.method : 'OTHER';
      const status = res.statusCode >= 100 && res.statusCode <= 599 ? String(res.statusCode) : '000';
      diagnostic(`OneCode Funnel request family=${family} method=${method} status=${status}`);
    });
    // No arbitrary local-service proxy, redirects, credentials or non-MCP routes.
    if (!expectedHosts.has((req.headers.host ?? '').toLowerCase()) ||
        family === 'unmatched' || /[\r\n]/.test(req.url ?? '') ||
        !(family === 'metadata' ? req.method === 'GET' : ['GET', 'POST', 'DELETE', 'OPTIONS'].includes(req.method ?? ''))) {
      res.writeHead(404).end(); return;
    }
    const outgoing = http.request({
      hostname: '127.0.0.1', port: Number(target.port), method: req.method, path: req.url,
      headers: { ...headers(req.headers), host: target.host }
    }, response => {
      if (family === 'metadata' && response.statusCode === 200) {
        // Only metadata is rewritten, never MCP bodies/streams. Keep the original
        // loopback guard and publish the exact transport-qualified resource URL.
        let body = '', bytes = 0;
        response.on('data', chunk => {
          bytes += Buffer.byteLength(chunk);
          if (bytes > 64 * 1024) { response.destroy(); if (!res.headersSent) res.writeHead(502); res.end(); return; }
          body += String(chunk);
        });
        response.once('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
        response.once('end', () => {
          if (res.writableEnded) return;
          try {
            const metadata: unknown = JSON.parse(body);
            if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) ||
                (metadata as Record<string, unknown>).resource !== target.origin + metadataPath ||
                response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') throw new Error();
            const rewritten = JSON.stringify({ ...metadata, resource: `https://${publicHost.replace(/:443$/, '')}${publicMount}${metadataPath}` });
            const finalHeaders = headers(response.headers);
            delete finalHeaders.etag; delete finalHeaders['content-encoding'];
            res.writeHead(200, { ...finalHeaders, 'content-type': 'application/json', 'content-length': Buffer.byteLength(rewritten) });
            res.end(rewritten);
          } catch { res.writeHead(502).end(); }
        });
        return;
      }
      res.writeHead(response.statusCode ?? 502, headers(response.headers));
      // A cut upstream stream is not a successfully completed MCP result.
      response.once('error', incomplete);
      response.once('aborted', incomplete);
      response.pipe(res);
    });
    outgoing.on('error', () => { if (res.headersSent) res.destroy(); else res.writeHead(502).end(); });
    req.on('aborted', () => outgoing.destroy());
    res.on('close', () => {
      if (!res.writableEnded) {
        if (!incompleteReported) {
          incompleteReported = true;
          diagnostic(`OneCode Funnel response closed before completion surface=${family} elapsedMs=${Date.now() - startedAt}`, true);
        }
        outgoing.destroy();
      }
    });
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
