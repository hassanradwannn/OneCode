/** Public Funnel checks must not use the device's split/MagicDNS answer. */
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import type { TailscalePublicFailure } from '../../shared/types.js';

const RESOLVER = 'https://cloudflare-dns.com/dns-query';
const METADATA = '/.well-known/oauth-protected-resource';
const MAX_BYTES = 64 * 1024;
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
interface ReadOptions { signal: AbortSignal; accept: string; address?: string }
interface Dependencies { read(url: URL, options: ReadOptions): Promise<JsonResponse> }
class ProbeReadError extends Error { constructor(readonly kind: 'transport' | 'response') { super(kind); } }
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
      method: 'GET', agent: false, signal: options.signal, servername: url.hostname, rejectUnauthorized: true,
      headers: { accept: options.accept, host: url.host, 'cache-control': 'no-cache', 'accept-encoding': 'identity' }
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
      if (contentType !== options.accept) { response.destroy(); finish(new ProbeReadError('response')); return; }
      let body = '', bytes = 0;
      response.on('data', chunk => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > MAX_BYTES) { response.destroy(); request.destroy(); finish(new ProbeReadError('response')); return; }
        body += String(chunk);
      });
      response.once('error', () => finish(new ProbeReadError('transport')));
      response.once('aborted', () => finish(new ProbeReadError('transport')));
      response.once('end', () => {
        try { finish(undefined, { status: 200, json: JSON.parse(body) }); }
        catch { finish(new ProbeReadError('response')); }
      });
    });
    request.once('error', () => finish(new ProbeReadError('transport')));
    timer = setTimeout(() => { request.destroy(); finish(new ProbeReadError('transport')); }, 4_000);
    request.end();
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

export async function probeFunnelPublic(value: string, signal: AbortSignal, overrides: Partial<Dependencies> = {}): Promise<FunnelPublicResult> {
  let endpoint: URL;
  try { endpoint = new URL(value); } catch { return { state: 'metadata-error' }; }
  if (endpoint.protocol !== 'https:' || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+\.ts\.net$/.test(endpoint.hostname) ||
      !['', '443', '8443', '10000'].includes(endpoint.port) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
      !/^\/onecode-[a-f0-9]{32}\/mcp\/core\/[A-Za-z0-9_-]{43}$/.test(endpoint.pathname)) return { state: 'metadata-error' };
  const deps = { read: readPublicJson, ...overrides };
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
  const answers = await Promise.all([1, 28].map(async type => {
    const query = new URL(RESOLVER); query.searchParams.set('name', endpoint.hostname); query.searchParams.set('type', String(type));
    try {
      const response = await deps.read(query, { signal: bounded, accept: 'application/dns-json' });
      return response.status === 200 ? dnsAddresses(response.json, endpoint.hostname, type as 1 | 28) : { addresses: [], error: true };
    } catch { return { addresses: [], error: true }; }
  }));
  signal.throwIfAborted();
  // Keep both families represented: four A answers must not crowd out working IPv6.
  const addresses: string[] = [];
  for (let index = 0; index < 4; index++) for (const answer of answers) {
    const address = answer.addresses[index];
    if (address && !addresses.includes(address) && addresses.length < 4) addresses.push(address);
  }
  if (!addresses.length) return { state: answers.some(answer => answer.error) ? 'dns-error' : 'dns-pending' };
  const metadata = new URL(endpoint.origin + METADATA + endpoint.pathname);
  const failures = new Set<TailscalePublicFailure>();
  const pending = new AbortController();
  const probeSignal = AbortSignal.any([bounded, pending.signal]);
  try {
    // A dead ingress must not hold a healthy one behind its socket timeout.
    await Promise.any(addresses.map(async address => {
    try {
      const response = await deps.read(metadata, { signal: probeSignal, accept: 'application/json', address });
      signal.throwIfAborted();
      probeSignal.throwIfAborted();
      if (response.status !== 200) failures.add('http-error');
      else if (!object(response.json) || response.json.resource !== endpoint.href) failures.add('metadata-error');
      else return;
    } catch (error) { if (error instanceof ProbeReadError && error.kind === 'response') failures.add('metadata-error'); }
    throw new Error('Ingress did not verify');
    }));
    signal.throwIfAborted();
    return { state: 'ready' };
  } catch {
    signal.throwIfAborted();
    return { state: failures.has('metadata-error') ? 'metadata-error' : failures.has('http-error') ? 'http-error' : 'tls-error' };
  } finally { pending.abort(); }
}
