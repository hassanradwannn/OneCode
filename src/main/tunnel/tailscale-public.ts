/** Public Funnel checks must not use the device's split/MagicDNS answer. */
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import type { TailscalePublicFailure } from '../../shared/types.js';

const RESOLVERS = ['https://cloudflare-dns.com/dns-query', 'https://dns.google/resolve'];
const METADATA = '/.well-known/oauth-protected-resource';
const MAX_BYTES = 64 * 1024;
const DNS_READ_MS = 4_000;
// Public Funnel replies can take several seconds, including a streamed initialize
// body. Keep the DNS race short without cutting off a healthy public response.
const PUBLIC_READ_MS = 12_000;
const PRIVATE_V4 = new BlockList();
for (const [address, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const)
  PRIVATE_V4.addSubnet(address, bits, 'ipv4');
const GLOBAL_V6 = new BlockList(); GLOBAL_V6.addSubnet('2000::', 3, 'ipv6');
const PRIVATE_V6 = new BlockList();
for (const [address, bits] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const)
  PRIVATE_V6.addSubnet(address, bits, 'ipv6');

export function isPublicIngressAddress(address: string): boolean {
  if (address.includes('%')) return false;
  const family = isIP(address);
  return family === 4 ? !PRIVATE_V4.check(address, 'ipv4')
    : family === 6 && GLOBAL_V6.check(address, 'ipv6') && !PRIVATE_V6.check(address, 'ipv6');
}

interface JsonResponse { status: number; json: unknown }
interface ReadOptions { signal: AbortSignal; accept: string; address?: string; body?: string; headers?: Record<string, string> }
interface Dependencies { read(url: URL, options: ReadOptions): Promise<JsonResponse> }
class ProbeReadError extends Error { constructor(readonly kind: 'transport' | 'response' | 'timeout') { super(kind); } }
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** No redirects, ambient cookies, proxy credentials or disabled certificate checks. */
export async function readPublicJson(url: URL, options: ReadOptions): Promise<JsonResponse> {
  options.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let settled = false, timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error, response?: JsonResponse) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (error) reject(error); else resolve(response!);
    };
    const requestOptions: https.RequestOptions = {
      method: options.body ? 'POST' : 'GET', agent: false, signal: options.signal, servername: url.hostname, rejectUnauthorized: true,
      headers: { ...options.headers, accept: options.accept, host: url.host, 'cache-control': 'no-cache', 'accept-encoding': 'identity',
        ...(options.body ? { 'content-type': 'application/json', 'mcp-protocol-version': '2025-06-18' } : {}) }
    };
    if (options.address) {
      const address = options.address, family = isIP(address);
      if (!isPublicIngressAddress(address)) { finish(new ProbeReadError('transport')); return; }
      requestOptions.lookup = (_hostname, lookupOptions, callback) => {
        if (lookupOptions.all) callback(null, [{ address, family }]);
        else callback(null, address, family);
      };
    }
    const request = https.request(url, requestOptions, response => {
      if (response.statusCode !== 200) { response.destroy(); finish(undefined, { status: response.statusCode ?? 0, json: null }); return; }
      const contentType = response.headers['content-type']?.split(';')[0]?.trim();
      // Google returns ordinary JSON for its JSON DNS API. Keep response media
      // validation separate from Cloudflare's exact request negotiation.
      const responseTypes = options.accept === 'application/dns-json'
        ? ['application/dns-json', 'application/json'] : options.accept.split(',').map(type => type.trim());
      if (!contentType || !responseTypes.includes(contentType)) { response.destroy(); finish(new ProbeReadError('response')); return; }
      let body = '', bytes = 0;
      response.setEncoding('utf8');
      const streamReply = (): boolean => {
        let boundary: RegExpExecArray | null;
        while ((boundary = /\r?\n\r?\n/.exec(body))) {
          const event = body.slice(0, boundary.index); body = body.slice(boundary.index + boundary[0].length);
          const data = event.split(/\r?\n/).filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).replace(/^ /, '')).join('\n');
          if (!data) continue;
          let json: unknown;
          try { json = JSON.parse(data); } catch { finish(new ProbeReadError('response')); return true; }
          // Ignore SSE comments/notifications; only the exact initialize reply
          // completes this bounded check. A server may leave the stream open.
          if (object(json) && json.jsonrpc === '2.0' && json.id === 'onecode-ingress') {
            finish(undefined, { status: 200, json }); return true;
          }
        }
        return false;
      };
      response.on('data', chunk => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > MAX_BYTES) { response.destroy(); request.destroy(); finish(new ProbeReadError('response')); return; }
        body += String(chunk);
        if (contentType === 'text/event-stream' && streamReply()) { response.destroy(); request.destroy(); }
      });
      response.once('error', () => finish(new ProbeReadError(options.signal.reason?.name === 'TimeoutError' ? 'timeout' : 'transport')));
      response.once('aborted', () => finish(new ProbeReadError(options.signal.reason?.name === 'TimeoutError' ? 'timeout' : 'transport')));
      response.once('end', () => {
        try {
          if (contentType === 'text/event-stream') { finish(new ProbeReadError('response')); return; }
          finish(undefined, { status: 200, json: JSON.parse(body) });
        }
        catch { finish(new ProbeReadError('response')); }
      });
    });
    request.once('error', () => finish(new ProbeReadError(options.signal.reason?.name === 'TimeoutError' ? 'timeout' : 'transport')));
    timer = setTimeout(() => { finish(new ProbeReadError('timeout')); request.destroy(); }, options.address ? PUBLIC_READ_MS : DNS_READ_MS);
    request.end(options.body);
  });
}

function dnsAddresses(value: unknown, hostname: string, type: 1 | 28): { addresses: string[]; error: boolean } {
  if (!object(value) || ![0, 3].includes(value.Status as number) || value.TC === true || !Array.isArray(value.Question) ||
      value.Question.length !== 1 || !object(value.Question[0]) || value.Question[0].type !== type ||
      String(value.Question[0].name).toLowerCase().replace(/\.$/, '') !== hostname) return { addresses: [], error: true };
  if (value.Status === 3) return { addresses: [], error: false };
  if (value.Answer === undefined) return { addresses: [], error: false };
  if (!Array.isArray(value.Answer) || value.Answer.length > 64) return { addresses: [], error: true };
  const answers = value.Answer.filter(object), names = new Set([hostname]);
  // Only addresses on this answer's actual CNAME chain qualify.
  for (let pass = 0; pass < 8; pass++) for (const answer of answers) {
    if (answer.type === 5 && names.has(String(answer.name).toLowerCase().replace(/\.$/, '')) &&
        typeof answer.data === 'string') names.add(answer.data.toLowerCase().replace(/\.$/, ''));
  }
  const candidates = answers.filter(answer => answer.type === type && names.has(String(answer.name).toLowerCase().replace(/\.$/, '')))
    .map(answer => answer.data).filter((address): address is string => typeof address === 'string');
  return { addresses: candidates.filter(address => isIP(address) === (type === 1 ? 4 : 6) && isPublicIngressAddress(address)),
    error: candidates.some(address => isIP(address) !== (type === 1 ? 4 : 6) || !isPublicIngressAddress(address)) };
}

export type FunnelPublicResult = { state: 'ready' | TailscalePublicFailure };

export async function probeFunnelPublic(value: string, signal: AbortSignal, overrides: Partial<Dependencies> = {}, headers?: Record<string, string>): Promise<FunnelPublicResult> {
  let endpoint: URL;
  try { endpoint = new URL(value); } catch { return { state: 'metadata-error' }; }
  if (endpoint.protocol !== 'https:' || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+\.ts\.net$/.test(endpoint.hostname) ||
      !['', '443', '8443', '10000'].includes(endpoint.port) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
      !/^\/onecode-[a-f0-9]{32}\/mcp\/core\/[A-Za-z0-9_-]{43}$/.test(endpoint.pathname)) return { state: 'metadata-error' };
  const deps = { read: readPublicJson, ...overrides };
  const metadata = new URL(endpoint.origin + METADATA + endpoint.pathname);
  const failures = new Set<TailscalePublicFailure>();
  const pending = new AbortController();
  const probeSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000), pending.signal]);
  let hasAddresses = false, dnsError = false;
  const ingress = new Map<string, Promise<void>>();
  try {
    // Race the complete DNS -> HTTPS paths. Waiting for both DNS answers first made
    // a working family wait for the other's resolver timeout on launch/resume.
    // Keep the other family alive until exact metadata verifies, not just DNS success.
    await Promise.any(RESOLVERS.flatMap(resolver => ([1, 28] as const).map(async type => {
      const query = new URL(resolver); query.searchParams.set('name', endpoint.hostname); query.searchParams.set('type', String(type));
      let answer: ReturnType<typeof dnsAddresses>;
      try {
        // Cloudflare selects its JSON DNS API only for this exact Accept value;
        // a combined JSON media range returns HTTP 400 instead of DNS answers.
        const response = await deps.read(query, { signal: probeSignal, accept: 'application/dns-json' });
        answer = response.status === 200 ? dnsAddresses(response.json, endpoint.hostname, type) : { addresses: [], error: true };
      } catch { answer = { addresses: [], error: true }; }
      dnsError ||= answer.error;
      probeSignal.throwIfAborted();
      const addresses = [...new Set(answer.addresses)].slice(0, 4);
      hasAddresses ||= addresses.length > 0;
      // Bounded to four addresses per family; a dead IPv4 route cannot crowd out IPv6.
      await Promise.any(addresses.map(address => {
        const existing = ingress.get(address);
        if (existing) return existing;
        const attempt = (async () => {
        let initializing = false;
        try {
          const response = await deps.read(metadata, { signal: probeSignal, accept: 'application/json', address });
          probeSignal.throwIfAborted();
          if (response.status !== 200) failures.add('http-error');
          else if (!object(response.json) || response.json.resource !== endpoint.href) failures.add('metadata-error');
          else {
            initializing = true;
            const initialized = await deps.read(endpoint, { signal: probeSignal, address, accept: 'application/json, text/event-stream', headers,
              body: JSON.stringify({ jsonrpc: '2.0', id: 'onecode-ingress', method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'OneCode ingress check', version: '1' } } }) });
            const rpc = initialized.json;
            if (initialized.status === 200 && object(rpc) && rpc.jsonrpc === '2.0' && rpc.id === 'onecode-ingress' && object(rpc.result) &&
                typeof rpc.result.protocolVersion === 'string' && object(rpc.result.serverInfo) && typeof rpc.result.serverInfo.name === 'string') return;
            failures.add('mcp-error');
          }
        } catch (error) {
          if (error instanceof ProbeReadError && error.kind === 'timeout') failures.add('timeout');
          else if (initializing) failures.add('mcp-error');
          else if (error instanceof ProbeReadError && error.kind === 'response') failures.add('metadata-error');
        }
        throw new Error('Ingress did not verify');
        })();
        ingress.set(address, attempt);
        return attempt;
      }));
    })));
    signal.throwIfAborted();
    return { state: 'ready' };
  } catch {
    signal.throwIfAborted();
    if (!hasAddresses) return { state: dnsError ? 'dns-error' : 'dns-pending' };
    return { state: failures.has('mcp-error') ? 'mcp-error' : failures.has('metadata-error') ? 'metadata-error' : failures.has('http-error') ? 'http-error' : failures.has('timeout') ? 'timeout' : 'tls-error' };
  } finally { pending.abort(); }
}
