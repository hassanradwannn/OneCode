import { readPublicJson } from './tailscale-public.js';

/** A printed quick-tunnel URL is not proof that its MCP origin is reachable. */
export async function probeCloudflareMcp(value: string, signal: AbortSignal,
  headers?: Record<string, string>, read = readPublicJson): Promise<boolean> {
  let endpoint: URL;
  try { endpoint = new URL(value); } catch { return false; }
  if (endpoint.protocol !== 'https:' || !/^[a-z0-9-]+\.trycloudflare\.com$/.test(endpoint.hostname) ||
      endpoint.port || endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
      !/^\/mcp\/(?:core|desktop|plugins)\/[A-Za-z0-9_-]{43}$/.test(endpoint.pathname)) return false;
  try {
    const result = await read(endpoint, { signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
      accept: 'application/json, text/event-stream', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 'onecode-ingress', method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'OneCode ingress check', version: '1' } } }) });
    const body = result.json as { jsonrpc?: string; id?: string; result?: { protocolVersion?: string; serverInfo?: { name?: string } } } | null;
    return !signal.aborted && result.status === 200 && body?.jsonrpc === '2.0' && body.id === 'onecode-ingress' &&
      typeof body.result?.protocolVersion === 'string' && typeof body.result?.serverInfo?.name === 'string';
  } catch { return false; }
}
