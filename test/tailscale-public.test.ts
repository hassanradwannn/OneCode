import https from 'node:https';
import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { isPublicIngressAddress, probeFunnelPublic, readPublicJson } from '../src/main/tunnel/tailscale-public.js';

const hostname = 'device.example.ts.net';
const endpoint = `https://${hostname}/onecode-${'a'.repeat(32)}/mcp/core/${'b'.repeat(43)}`;
const publicA = '104.16.1.1', publicAAAA = '2606:4700::1';
const signal = () => new AbortController().signal;
const dns = (type: number, data: string[] = []) => ({ Status: 0, Question: [{ name: hostname + '.', type }],
  Answer: data.map(data => ({ name: hostname + '.', type, data })) });
afterEach(() => vi.restoreAllMocks());

it.each(['0.0.0.0', '10.1.2.3', '100.64.0.1', '100.127.255.254', '127.0.0.1', '169.254.1.1', '172.31.0.1',
  '192.0.2.1', '192.168.1.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255',
  '::', '::1', '::ffff:127.0.0.1', '::ffff:104.16.1.1', '64:ff9b::a00:1', 'fc00::1', 'fd7a:115c:a1e0::1',
  'fe80::1', 'fe80::1%eth0', 'ff02::1', '2001:db8::1', '2001::1', '2002:a00:1::', '3fff::1', 'garbage'])
  ('rejects nonpublic, mapped and transition ingress address %s', address => expect(isPublicIngressAddress(address)).toBe(false));
it.each([publicA, publicAAAA, '100.128.0.1', '199.165.136.1'])('accepts global ingress address %s', address => expect(isPublicIngressAddress(address)).toBe(true));

function fixture() {
  const calls: Array<{ url: URL; address?: string }> = [];
  const read = vi.fn(async (url: URL, options: { address?: string }): Promise<{ status: number; json: unknown }> => {
    calls.push({ url, address: options.address });
    if (!options.address) return { status: 200, json: dns(Number(url.searchParams.get('type')), url.searchParams.get('type') === '1' ? [publicA] : [publicAAAA]) };
    return { status: 200, json: { resource: endpoint, authorization_servers: [] } };
  });
  return { read, calls };
}

it('queries only the hostname at Cloudflare and checks the exact metadata via a public address, bypassing MagicDNS', async () => {
  const f = fixture();
  expect(await probeFunnelPublic(endpoint, signal(), f)).toEqual({ state: 'ready' });
  expect(f.calls).toHaveLength(4);
  for (const { url } of f.calls.slice(0, 2)) {
    expect(url.origin + url.pathname).toBe('https://cloudflare-dns.com/dns-query');
    expect([...url.searchParams.keys()].sort()).toEqual(['name', 'type']);
    expect(url.searchParams.get('name')).toBe(hostname);
    expect(url.href).not.toContain('onecode-'); expect(url.href).not.toContain('b'.repeat(43));
  }
  expect(f.calls[2]?.address).toBe(publicA);
  expect(f.calls[2]?.url.href).toBe(`https://${hostname}/.well-known/oauth-protected-resource${new URL(endpoint).pathname}`);
});
it('verifies a working IPv6 ingress immediately while an IPv4 ingress hangs, then aborts the loser', async () => {
  const signals: AbortSignal[] = [];
  const read = vi.fn(async (url: URL, options: {address?: string; signal: AbortSignal}): Promise<{status:number;json:unknown}> => {
    if (!options.address) return {status:200,json:dns(Number(url.searchParams.get('type')),url.searchParams.get('type') === '1' ? [publicA,'104.16.1.2','104.16.1.3','104.16.1.4'] : [publicAAAA])};
    signals.push(options.signal);
    if (options.address === publicAAAA) return {status:200,json:{resource:endpoint}};
    return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(Error('aborted')), {once:true}));
  });
  expect(await probeFunnelPublic(endpoint, signal(), {read})).toEqual({state:'ready'});
  expect(signals.length).toBeLessThanOrEqual(4);
  expect(signals.every(signal => signal.aborted)).toBe(true);
});

it.each([undefined, 3])('waits for public DNS propagation without probing a private/system answer: %s', async status => {
  const read = vi.fn(async (url: URL) => ({ status: 200, json: { ...dns(Number(url.searchParams.get('type'))), ...(status ? { Status: status } : {}) } }));
  expect(await probeFunnelPublic(endpoint, signal(), { read })).toEqual({ state: 'dns-pending' });
  expect(read).toHaveBeenCalledTimes(2);
});

it('refuses private-only public answers instead of falling back to working tailnet DNS', async () => {
  const read = vi.fn(async (url: URL) => ({ status: 200, json: dns(Number(url.searchParams.get('type')), url.searchParams.get('type') === '1' ? ['100.64.0.2'] : ['fd7a:115c:a1e0::1']) }));
  expect(await probeFunnelPublic(endpoint, signal(), { read })).toEqual({ state: 'dns-error' });
  expect(read).toHaveBeenCalledTimes(2);
});

it('accepts a public address only from the actual DNS question CNAME chain', async () => {
  const f = fixture();
  f.read.mockImplementation(async (url, options) => options.address ? { status: 200, json: { resource: endpoint } } : {
    status: 200, json: { ...dns(Number(url.searchParams.get('type'))), Answer: [
      { name: 'unrelated.example', type: 1, data: publicA },
      { name: hostname, type: 5, data: 'ingress.example.' },
      { name: 'ingress.example.', type: Number(url.searchParams.get('type')), data: url.searchParams.get('type') === '1' ? publicA : publicAAAA }
    ] }
  });
  expect(await probeFunnelPublic(endpoint, signal(), f)).toEqual({ state: 'ready' });
});

it('tries another published ingress address when the first cannot establish verified TLS', async () => {
  const f = fixture();
  f.read.mockImplementation(async (url, options) => {
    if (!options.address) return { status: 200, json: dns(Number(url.searchParams.get('type')), url.searchParams.get('type') === '1' ? [publicA] : [publicAAAA]) };
    if (options.address === publicA) throw new Error('TLS EOF, private detail must not escape');
    return { status: 200, json: { resource: endpoint } };
  });
  expect(await probeFunnelPublic(endpoint, signal(), f)).toEqual({ state: 'ready' });
  expect(f.read).toHaveBeenCalledTimes(4);
});

it.each(['wrong-mount', 'wrong-token', 'wrong-host', 'redirect', 'tls-failure'])('does not accept %s as the current connector', async reason => {
  const f = fixture();
  f.read.mockImplementation(async (url, options) => {
    if (!options.address) return { status: 200, json: dns(Number(url.searchParams.get('type')), url.searchParams.get('type') === '1' ? [publicA] : []) };
    if (reason === 'tls-failure') throw new Error('certificate rejected');
    return { status: reason === 'redirect' ? 302 : 200, json: { resource: endpoint.replace(reason === 'wrong-mount' ? 'a'.repeat(32) : reason === 'wrong-token' ? 'b'.repeat(43) : hostname, 'different') } };
  });
  expect(await probeFunnelPublic(endpoint, signal(), f)).toEqual({ state: reason === 'tls-failure' ? 'tls-error' : reason === 'redirect' ? 'http-error' : 'metadata-error' });
});

it('does not return late success after cancellation', async () => {
  const f = fixture(), controller = new AbortController();
  let release!: (value: { status: number; json: unknown }) => void;
  f.read.mockImplementation(async (url, options) => !options.address
    ? { status: 200, json: dns(Number(url.searchParams.get('type')), url.searchParams.get('type') === '1' ? [publicA] : []) }
    : new Promise(resolve => { release = resolve; }));
  const pending = probeFunnelPublic(endpoint, controller.signal, f);
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  controller.abort(); release({ status: 200, json: { resource: endpoint } });
  await expect(pending).rejects.toThrow();
});

function fakeHttps(status: number, contentType: string, body: string) {
  const response = Object.assign(new EventEmitter(), { statusCode: status, headers: { 'content-type': contentType }, destroy: vi.fn() });
  const request = Object.assign(new EventEmitter(), { destroy: vi.fn(), end: () => queueMicrotask(() => {
    callback(response); if (!response.destroy.mock.calls.length) { response.emit('data', Buffer.from(body)); response.emit('end'); }
  }) });
  let callback: (response: any) => void = () => {};
  const spy = vi.spyOn(https, 'request').mockImplementation(((_url: URL, _options: https.RequestOptions, done: (response: any) => void) => {
    callback = done; return request;
  }) as unknown as typeof https.request);
  return { spy, request, response };
}

it('uses the original TLS Host/SNI, strict certificates and forced public socket address', async () => {
  const f = fakeHttps(200, 'application/json', '{}');
  await readPublicJson(new URL(endpoint), { signal: signal(), accept: 'application/json', address: publicA });
  const options = f.spy.mock.calls[0]![1] as https.RequestOptions;
  expect(options).toMatchObject({ servername: hostname, rejectUnauthorized: true, agent: false, method: 'GET', headers: { host: hostname } });
  const result = vi.fn(); (options.lookup as any)(hostname, { all: true }, result);
  expect(result).toHaveBeenCalledWith(null, [{ address: publicA, family: 4 }]);
});

it('does not follow redirects or consume arbitrary response bodies', async () => {
  const f = fakeHttps(302, 'text/html', 'redirect');
  expect(await readPublicJson(new URL(endpoint), { signal: signal(), accept: 'application/json', address: publicA })).toEqual({ status: 302, json: null });
  expect(f.spy).toHaveBeenCalledTimes(1); expect(f.response.destroy).toHaveBeenCalled();
});

it.each(['oversized', 'invalid-json', 'wrong-type'])('bounds or refuses %s metadata', async reason => {
  const f = fakeHttps(200, reason === 'wrong-type' ? 'text/html' : 'application/json', reason === 'oversized' ? 'x'.repeat(65537) : 'not json');
  await expect(readPublicJson(new URL(endpoint), { signal: signal(), accept: 'application/json', address: publicA })).rejects.toThrow();
  expect(f.spy).toHaveBeenCalledTimes(1);
});
