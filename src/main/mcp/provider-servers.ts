import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { CHAT_PROVIDERS, type ChatProvider } from '../../shared/chat-provider.js';
import { startMcpServer, type McpEndpoint } from './server.js';
import { SURFACE_IDS, type SurfaceId } from './surfaces.js';
import type { ToolContext } from './kernel.js';

export interface ProviderEndpoints extends McpEndpoint {
  providers: Record<ChatProvider, McpEndpoint>;
}

/** Independent provider MCP listeners behind one path-only HTTPS tunnel gateway.
 * The gateway does not interpret MCP or choose a provider from mutable UI state.
 * A URL's independent secret permanently selects its provider's listening server.
 */
export async function startProviderMcpServers(
  context: () => ToolContext,
  kept: Partial<Record<ChatProvider, Partial<Record<SurfaceId, string>>>>,
  selected: () => ChatProvider
): Promise<ProviderEndpoints> {
  const providers = {} as Record<ChatProvider, McpEndpoint>;
  const started: McpEndpoint[] = [];
  const tokens = new Set<string>();
  try {
    for (const provider of CHAT_PROVIDERS) {
      const distinct = { ...kept[provider] };
      const reserved = new Set(tokens);
      for (const id of SURFACE_IDS) if (distinct[id]) {
        if (reserved.has(distinct[id]!)) delete distinct[id];
        else reserved.add(distinct[id]!);
      }
      const endpoint = await startMcpServer(context, distinct, provider);
      started.push(endpoint); providers[provider] = endpoint;
      for (const value of Object.values(endpoint.urls)) {
        const token = new URL(value).pathname.split('/').at(-1)!;
        if (tokens.has(token)) throw new Error('Provider connector token collision');
        tokens.add(token);
      }
    }
  } catch (error) { await Promise.allSettled(started.map(endpoint => endpoint.stop())); throw error; }
  const routes = new Map<string, URL>();
  for (const provider of CHAT_PROVIDERS) for (const value of Object.values(providers[provider].urls)) {
    const target = new URL(value);
    for (const prefix of ['', '/.well-known/oauth-protected-resource']) {
      const route = new URL(target); route.pathname = prefix + target.pathname;
      routes.set(route.pathname, route);
    }
  }
  const sockets = new Set<Socket>();
  let stopping = false;
  const gateway = http.createServer((request, response) => {
    const target = routes.get((request.url ?? '').split('?')[0]!);
    if (stopping || !target) {
      response.writeHead(stopping ? 503 : 404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: stopping ? 'server_stopping' : 'not_found' })); return;
    }
    // The listener is loopback-only. Keep the same Host/Origin protections as MCP
    // rather than accepting arbitrary browser origins at the forwarding boundary.
    const host = request.headers.host ?? '';
    const origin = request.headers.origin;
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host) ||
        (origin !== undefined && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin))) {
      response.writeHead(403, { 'content-type': 'application/json' }); response.end('{"error":"forbidden_origin"}'); return;
    }
    const upstream = http.request(target, { method: request.method,
      headers: { ...request.headers, host: target.host } }, result => {
      if (target.pathname.startsWith('/.well-known/oauth-protected-resource') && result.statusCode === 200) {
        const chunks: Buffer[] = []; let bytes = 0;
        result.on('data', chunk => { bytes += chunk.length; if (bytes > 65536) result.destroy(new Error('Metadata too large')); else chunks.push(chunk); });
        result.once('error', () => { response.writeHead(502); response.end(); });
        result.once('end', () => {
          try {
            const metadata = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            const path = target.pathname.slice('/.well-known/oauth-protected-resource'.length);
            if (metadata.resource !== target.origin + path) throw new Error('Unexpected resource');
            const address = gateway.address() as AddressInfo;
            const body = JSON.stringify({ ...metadata, resource: `http://127.0.0.1:${address.port}${path}` });
            response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
            response.end(body);
          } catch { response.writeHead(502); response.end(); }
        });
      } else {
        response.writeHead(result.statusCode ?? 502, result.headers);
        result.once('error', () => response.destroy());
        result.once('aborted', () => response.destroy());
        result.pipe(response);
      }
    });
    upstream.once('error', () => { if (response.headersSent) response.destroy(); else response.writeHead(502).end(); });
    request.once('aborted', () => upstream.destroy());
    response.once('close', () => { if (!response.writableFinished) upstream.destroy(); });
    request.pipe(upstream);
  });
  gateway.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  try { await new Promise<void>((resolve, reject) => {
    gateway.once('error', reject); gateway.listen(0, '127.0.0.1', () => { gateway.off('error', reject); resolve(); });
  }); } catch (error) { await Promise.allSettled(started.map(endpoint => endpoint.stop())); throw error; }
  const port = (gateway.address() as AddressInfo).port;
  const urls = (provider: ChatProvider) => Object.fromEntries(SURFACE_IDS.map(id =>
    [id, `http://127.0.0.1:${port}${new URL(providers[provider].urls[id]).pathname}`])) as Record<SurfaceId, string>;
  let stopped: Promise<void> | null = null;
  return {
    providers, port,
    get url() { return urls(selected()).core; },
    get urls() { return urls(selected()); },
    publication: (surface, observe) => providers[selected()].publication?.(surface, observe),
    stop(options) {
      stopping = true;
      if (options?.forceAfterMs !== undefined) {
        const timer = setTimeout(() => { for (const socket of sockets) socket.destroy(); }, options.forceAfterMs); timer.unref();
      }
      stopped ??= (async () => {
        const closed = new Promise<void>(resolve => gateway.close(() => resolve()));
        gateway.closeIdleConnections();
        await Promise.allSettled(started.map(endpoint => endpoint.stop(options)));
        await closed;
      })();
      return stopped;
    }
  };
}
