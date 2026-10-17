import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ app: { getPath: () => '', getAppPath: () => process.cwd() } }));
vi.mock('../src/main/exec.js', () => ({ childEnv: () => ({}) }));
vi.mock('../src/main/logger.js', () => ({ logInfo: vi.fn(), logWarn: vi.fn() }));
import { startTailscale, assertFunnelRouteSafe, FUNNEL_METADATA_PREFIX, type FunnelCustody } from '../src/main/tunnel/tailscale.js';
import type { TunnelHandle, TunnelReport } from '../src/main/tunnel/index.js';
import type { FunnelPublicResult } from '../src/main/tunnel/tailscale-public.js';

const dirs: string[] = [];
const handles: TunnelHandle[] = [];
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const DNS = 'device.example.ts.net';
const token = 'x'.repeat(43);
function fixture(initial: Record<string, any> = {}) {
  let current: Record<string, any> = clone(initial);
  const node: Record<string, any> = { BackendState: 'Running', AuthURL: '', Self: { ID: 'node-1', DNSName: `${DNS}.`, Online: true, CapMap: { funnel: [], https: [] } } };
  const calls: string[][] = [], reports: TunnelReport[] = [];
  const probe = vi.fn(async (_url: string, _signal: AbortSignal): Promise<FunnelPublicResult> => ({ state: 'ready' }));
  let now = 0, retryWindowMs = 10 * 60_000;
  let version = '1.102.2\ncommit: test', configReads = 0;
  let beforeRead: (() => void) | undefined;
  let failMutation: Error | undefined;
  let failAddition: number | undefined, additions = 0;
  let onOff: (() => void) | undefined;
  const run = vi.fn(async (_binary: string, args: string[]) => {
    calls.push(args);
    if (args[0] === 'version') return version;
    if (args[0] === 'status') return JSON.stringify(node);
    if (args[1] === 'status') { configReads++; beforeRead?.(); return JSON.stringify(current); }
    const port = args.find(value => value.startsWith('--https='))!.split('=')[1]!;
    const mount = args.find(value => value.startsWith('--set-path='))!.slice('--set-path='.length);
    const host = `${DNS}:${port}`;
    if (args.at(-1) === 'off') {
      delete current.Web?.[host]?.Handlers[mount];
      if (!Object.keys(current.Web?.[host]?.Handlers ?? {}).length) {
        delete current.Web?.[host]; delete current.TCP?.[port]; delete current.AllowFunnel?.[host];
      }
      onOff?.();
    } else {
      additions++;
      current.TCP ??= {}; current.Web ??= {}; current.AllowFunnel ??= {};
      current.TCP[port] = { HTTPS: true };
      current.Web[host] ??= { Handlers: {} };
      current.Web[host].Handlers[mount] = { Proxy: args.at(-1) };
      current.AllowFunnel[host] = true;
      if (failMutation || failAddition === additions) throw failMutation ?? new Error('Second native update failed');
    }
    return '';
  });
  const relayStops: Array<ReturnType<typeof vi.fn>> = [];
  const relay = vi.fn(async () => {
    const stop = vi.fn(async () => {}); relayStops.push(stop);
    return { origin: `http://127.0.0.1:${32000 + relayStops.length}`, stop };
  });
  const mutations = () => calls.filter(args => args[0] === 'funnel' && args[1] !== 'status');
  return {
    node, calls, reports, run, relay, relayStops, mutations, probe,
    set now(value: number) { now = value; }, set retryWindowMs(value: number) { retryWindowMs = value; },
    get current() { return current; }, set current(value) { current = value; },
    get configReads() { return configReads; }, set beforeRead(value: (() => void) | undefined) { beforeRead = value; },
    set version(value: string) { version = value; }, set failMutation(value: Error) { failMutation = value; },
    set failAddition(value: number) { failAddition = value; },
    set onOff(value: () => void) { onOff = value; },
    async start(dir?: string, locate = () => 'C:/Program Files/Tailscale/tailscale.exe', watchMs = 60_000, waitReady = true) {
      const stateDir = dir ?? await fs.mkdtemp(path.join(os.tmpdir(), 'onecode-funnel-'));
      if (!dir) dirs.push(stateDir);
      const handle = await startTailscale({ localUrl: `http://127.0.0.1:28800/mcp/core/${token}`, settings: { kind: 'tailscale', tunnelId: '', desktopTunnelId: '', binaryPath: '' }, apiKey: null, report: report => reports.push(report) },
        { run, relay, stateDir, locate, watchMs, probe, now: () => now, retryWindowMs });
      handles.push(handle);
      if (waitReady) await vi.waitFor(() => expect(reports.at(-1)?.state).toBe('connected'));
      return { handle, stateDir };
    }
  };
}
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.stop();
  await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});
const existing = () => ({ TCP: { '443': { HTTPS: true }, '8443': { HTTPS: true } }, Web: { [`${DNS}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:4000' }, '/other': { Text: 'public' } } }, [`${DNS}:8443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:5000' } } } }, AllowFunnel: { [`${DNS}:443`]: true } });

describe('system Tailscale Funnel custody', () => {
  it('adds exactly two owned paths on already-public443, preserving root/bucket/private routes and path-specific cleanup', async () => {
    const initial = existing(); const f = fixture(initial);
    const { handle, stateDir } = await f.start();
    expect(f.calls.slice(0, 3)).toEqual([['version'], ['status', '--json'], ['funnel', 'status', '--json']]);
    expect(f.mutations()).toHaveLength(2);
    expect(f.mutations()[0]).toEqual(['funnel', '--bg', '--https=443', expect.stringMatching(/^--set-path=\/onecode-[a-f0-9]{32}$/), '--yes', 'http://127.0.0.1:32001']);
    const mount = f.mutations()[0]![3]!.slice('--set-path='.length);
    expect(f.mutations()[1]).toEqual(['funnel', '--bg', '--https=443', `--set-path=${FUNNEL_METADATA_PREFIX}${mount}`, '--yes', `http://127.0.0.1:32001${FUNNEL_METADATA_PREFIX}`]);
    expect(f.current.Web[`${DNS}:443`].Handlers['/']).toEqual(initial.Web[`${DNS}:443`].Handlers['/']);
    expect(f.current.Web[`${DNS}:443`].Handlers['/other']).toEqual(initial.Web[`${DNS}:443`].Handlers['/other']);
    expect(f.current.Web[`${DNS}:8443`]).toEqual(initial.Web[`${DNS}:8443`]);
    expect(f.current.AllowFunnel[`${DNS}:8443`]).toBeUndefined();
    expect(f.reports.at(-1)).toMatchObject({ state: 'connected', publicUrl: expect.stringMatching(/^https:\/\/device.example.ts.net\/onecode-[a-f0-9]{32}\/mcp\/core\//), tailscale: { cli: 'ready', account: 'ready', funnel: 'ready', version: '1.102.2' } });
    const receipt = await fs.readFile(path.join(stateDir, (await fs.readdir(stateDir))[0]!), 'utf8');
    expect(receipt).not.toContain(token); expect(receipt).not.toContain('AuthURL');
    await handle.stop();
    expect(f.mutations()[2]).toEqual(['funnel', '--https=443', f.mutations()[1]![3], 'off']);
    expect(f.mutations()[3]).toEqual(['funnel', '--https=443', f.mutations()[0]![3], 'off']);
    expect(f.current.Web).toEqual(initial.Web);
    expect(f.current.AllowFunnel).toEqual(initial.AllowFunnel);
    expect(f.calls.flat()).not.toEqual(expect.arrayContaining(['reset', 'up', 'down', 'login']));
  });
  it('reuses its persisted native URL after stop/reconnect while replacing only its relay target', async () => {
    const f = fixture(existing()); const first = await f.start();
    const url = f.reports.at(-1)?.publicUrl;
    await first.handle.stop();
    await f.start(first.stateDir);
    expect(f.reports.at(-1)?.publicUrl).toBe(url);
    expect(f.mutations().at(-1)?.at(-1)).toBe(`http://127.0.0.1:32002${FUNNEL_METADATA_PREFIX}`);
  });
  it('keeps a private443 private, and migrates a stopped legacy10000 receipt to already-public443 without orphaning paths', async () => {
    const initial = existing(); initial.AllowFunnel = {} as typeof initial.AllowFunnel;
    const f = fixture(initial); const first = await f.start();
    expect(f.mutations()[0]?.[2]).toBe('--https=10000');
    expect(f.current.AllowFunnel[`${DNS}:443`]).toBeUndefined();
    await first.handle.stop();
    const file = path.join(first.stateDir, (await fs.readdir(first.stateDir))[0]!);
    const old = JSON.parse(await fs.readFile(file, 'utf8')); delete old.metadata;
    await fs.writeFile(file, JSON.stringify(old));
    f.current.AllowFunnel[`${DNS}:443`] = true; // external owner explicitly publishes its own listener
    const mutationsBefore = f.mutations().length;
    await f.start(first.stateDir);
    expect(f.mutations().slice(mutationsBefore).map(args => args[2])).toEqual(['--https=443', '--https=443']);
    const updated = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(updated).toMatchObject({ port: 443, mount: old.mount, metadata: true });
    expect(updated.previousProxy).toBeUndefined();
    expect(f.current.Web[`${DNS}:10000`]).toBeUndefined();
    expect(f.current.Web[`${DNS}:8443`]).toEqual(initial.Web[`${DNS}:8443`]);
  });
  it('refuses moving active10000 custody to443 until Disconnect has removed both old paths', async () => {
    const initial = existing(); initial.AllowFunnel = {} as typeof initial.AllowFunnel;
    const f = fixture(initial); const first = await f.start();
    f.current.AllowFunnel[`${DNS}:443`] = true;
    const before = clone(f.current);
    await expect(f.start(first.stateDir)).rejects.toThrow('Disconnect the previous');
    expect(f.current).toEqual(before); expect(f.mutations()).toHaveLength(2);
  });
  it('refuses unknown metadata-path custody even when the main route remains owned', async () => {
    const f = fixture(existing()); const first = await f.start();
    const metadata = f.mutations()[1]![3]!.slice('--set-path='.length);
    f.current.Web[`${DNS}:443`].Handlers[metadata] = { Text: 'foreign metadata route' };
    await first.handle.stop();
    expect(f.current.Web[`${DNS}:443`].Handlers[metadata]).toEqual({ Text: 'foreign metadata route' });
    await expect(f.start(first.stateDir)).rejects.toThrow('changed outside this app');
  });
  it('does not remove or adopt a route changed outside the app', async () => {
    const f = fixture(existing()); const first = await f.start();
    const mount = f.mutations()[0]![3]!.slice('--set-path='.length);
    f.current.Web[`${DNS}:443`].Handlers[mount] = { Proxy: 'http://127.0.0.1:9999' };
    await first.handle.stop();
    expect(f.mutations()).toHaveLength(3);
    await expect(f.start(first.stateDir)).rejects.toThrow('changed outside this app');
    expect(f.mutations()).toHaveLength(3);
  });
  it('revalidates native device identity before each path cleanup', async () => {
    const f = fixture(existing()); const first = await f.start();
    const main = f.mutations()[0]![3]!.slice('--set-path='.length);
    f.onOff = () => { f.node.Self.ID = 'different-device'; };
    await first.handle.stop();
    expect(f.mutations()).toHaveLength(3); // two adds + metadata off; main off refused
    expect(f.current.Web[`${DNS}:443`].Handlers[main]).toEqual({ Proxy: 'http://127.0.0.1:32001' });
  });
  it('refuses a different native device/name before modifying its saved route', async () => {
    const f = fixture(); const first = await f.start(); await first.handle.stop();
    f.node.Self.ID = 'other-node';
    await expect(f.start(first.stateDir)).rejects.toThrow('device/name changed');
    expect(f.mutations()).toHaveLength(4);
  });
  it('refuses unreadable custody instead of claiming a matching app-looking route', async () => {
    const f = fixture(); const first = await f.start(); await first.handle.stop();
    await fs.writeFile(path.join(first.stateDir, (await fs.readdir(first.stateDir))[0]!), '{}');
    await expect(f.start(first.stateDir)).rejects.toThrow('custody is unreadable');
    expect(f.mutations()).toHaveLength(4);
  });
  it('refuses all occupied ports and foreground sessions without any native change', async () => {
    const f = fixture({ ...existing(), AllowFunnel: {}, TCP: { '443': { HTTPS: true }, '8443': { HTTPS: true }, '10000': { TCPForward: '127.0.0.1:6000' } } });
    await expect(f.start()).rejects.toThrow('already have routes');
    expect(f.mutations()).toHaveLength(0);
    const foreground = fixture({ Foreground: { 'session-1': { TCP: { '443': { HTTPS: true } } } } });
    await expect(foreground.start()).rejects.toThrow('foreground');
    expect(foreground.mutations()).toHaveLength(0);
  });
  it('refuses promoting private routes and rejects TCP/path collisions', () => {
    const owned: FunnelCustody = { version: 1, nodeId: 'node-1', dnsName: DNS, port: 443, mount: `/onecode-${'a'.repeat(32)}`, proxy: 'http://127.0.0.1:32001' };
    expect(() => assertFunnelRouteSafe({ TCP: { '443': { HTTPS: true } }, Web: { [`${DNS}:443`]: { Handlers: { '/private': { Proxy: 'http://127.0.0.1:5000' } } } } }, owned)).toThrow('private Serve routes');
    expect(() => assertFunnelRouteSafe({ TCP: { '443': { TCPForward: '127.0.0.1:22' } } }, owned)).toThrow('another listener');
    expect(() => assertFunnelRouteSafe({ Web: { [`${DNS}:443`]: { Handlers: { [owned.mount]: { Text: 'someone else' } } } } }, owned)).toThrow('changed outside');
  });
  it('keeps the old receipt intact if native state changes during preparation', async () => {
    const f = fixture(); const first = await f.start(); await first.handle.stop();
    const file = path.join(first.stateDir, (await fs.readdir(first.stateDir))[0]!);
    const before = await fs.readFile(file, 'utf8');
    const originalReads = f.configReads;
    f.beforeRead = () => { if (f.configReads === originalReads + 2) f.current.Web.extra = { Handlers: { '/': { Text: 'changed' } } }; };
    await expect(f.start(first.stateDir)).rejects.toThrow('changed during preparation');
    expect(await fs.readFile(file, 'utf8')).toBe(before);
    expect(f.mutations()).toHaveLength(4);
    expect(f.relayStops.at(-1)).toHaveBeenCalledOnce();
  });
  it('recovers exact pre-mutation custody after an interrupted relay-target rotation', async () => {
    const f = fixture(); const first = await f.start();
    // Simulate crash without running stop; current native route still points to old relay.
    const file = path.join(first.stateDir, (await fs.readdir(first.stateDir))[0]!);
    const stored = JSON.parse(await fs.readFile(file, 'utf8'));
    await fs.writeFile(file, JSON.stringify({ ...stored, proxy: 'http://127.0.0.1:32199', previousProxy: stored.proxy, previousMetadataProxy: stored.proxy }));
    await f.start(first.stateDir);
    expect(f.mutations()).toHaveLength(4);
    const committed = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(committed.proxy).toBe('http://127.0.0.1:32002');
    expect(committed.previousProxy).toBeUndefined();
    expect(committed.previousMetadataProxy).toBeUndefined();
  });
  it('handles an ambiguous CLI failure by checking custody and removing only its exact new route', async () => {
    const f = fixture(existing()); f.failMutation = new Error('OneCode attacker-controlled error with session_key=secret');
    await expect(f.start()).rejects.toThrow('could not configure or verify');
    expect(f.mutations()).toHaveLength(2);
    expect(f.mutations()[1]?.at(-1)).toBe('off');
    expect(f.current.Web).toEqual(existing().Web);
    expect(JSON.stringify(f.reports)).not.toMatch(/session_key|attacker|secret/);
  });
  it('cleans both exact paths after an ambiguous second add failure and reuses that intent safely on restart', async () => {
    const initial = existing(); const f = fixture(initial); f.failAddition = 2;
    await expect(f.start()).rejects.toThrow('could not configure or verify');
    expect(f.mutations()).toHaveLength(4);
    expect(f.mutations().slice(2).every(args => args.at(-1) === 'off')).toBe(true);
    expect(f.current.Web).toEqual(initial.Web);
    expect(f.reports.some(report => report.state === 'connected')).toBe(false);
    const dir = dirs.at(-1)!;
    await f.start(dir);
    expect(f.reports.at(-1)?.state).toBe('connected');
    expect(f.mutations()).toHaveLength(6);
  });
  it('does not overwrite a metadata path inserted by another owner between the two adds', async () => {
    const f = fixture(existing());
    let metadataMount = '';
    f.beforeRead = () => {
      if (f.configReads === 3) {
        metadataMount = FUNNEL_METADATA_PREFIX + f.mutations()[0]![3]!.slice('--set-path='.length);
        f.current.Web[`${DNS}:443`].Handlers[metadataMount] = { Text: 'foreign' };
      }
    };
    await expect(f.start()).rejects.toThrow('changed between');
    expect(f.current.Web[`${DNS}:443`].Handlers[metadataMount]).toEqual({ Text: 'foreign' });
    expect(f.mutations()).toHaveLength(2); // main add + exact main cleanup; no metadata mutation
  });
  it('recovers different proven main/metadata targets after a crash between their rotations', async () => {
    const f = fixture(existing()); const first = await f.start();
    const file = path.join(first.stateDir, (await fs.readdir(first.stateDir))[0]!);
    const old = JSON.parse(await fs.readFile(file, 'utf8'));
    f.current.Web[`${DNS}:443`].Handlers[old.mount] = { Proxy: 'http://127.0.0.1:32999' };
    await fs.writeFile(file, JSON.stringify({ ...old, proxy: 'http://127.0.0.1:32999', previousProxy: old.proxy, previousMetadataProxy: old.proxy }));
    await f.start(first.stateDir);
    expect(f.reports.at(-1)?.state).toBe('connected');
    expect(f.current.Web[`${DNS}:443`].Handlers[old.mount]).toEqual({ Proxy: 'http://127.0.0.1:32002' });
    expect(f.current.Web[`${DNS}:443`].Handlers[FUNNEL_METADATA_PREFIX + old.mount]).toEqual({ Proxy: 'http://127.0.0.1:32002' + FUNNEL_METADATA_PREFIX });
  });
  it('refuses publication if another route changes and never restores/deletes that unrelated change', async () => {
    const f = fixture(existing());
    f.beforeRead = () => { if (f.configReads === 3) f.current.Web[`${DNS}:8443`].Handlers['/new-private'] = { Text: 'user changed' }; };
    await expect(f.start()).rejects.toThrow('Tailscale routes changed');
    expect(f.reports.some(report => report.state === 'connected')).toBe(false);
    expect(f.current.Web[`${DNS}:8443`].Handlers['/new-private']).toEqual({ Text: 'user changed' });
    expect(f.current.AllowFunnel[`${DNS}:8443`]).toBeUndefined();
  });
  it('health checks report a deleted/revoked route without recreating it', async () => {
    const f = fixture(); const started = await f.start(undefined, undefined, 20);
    const mount = f.mutations()[0]![3]!.slice('--set-path='.length);
    delete f.current.Web[`${DNS}:443`].Handlers[mount];
    await vi.waitFor(() => expect(f.reports.at(-1)).toMatchObject({ state: 'tunnel-unavailable', publicUrl: null, tailscale: { funnel: 'error' } }));
    expect(f.mutations()).toHaveLength(2);
    await started.handle.stop();
    expect(f.mutations()).toHaveLength(3);
  });
  it('keeps its stable configured route while public DNS propagates, then verifies without native replay', async () => {
    const f = fixture(); f.probe.mockResolvedValue({ state: 'dns-pending' });
    const started = await f.start(undefined, undefined, 20, false);
    await vi.waitFor(() => expect(f.reports.at(-1)).toMatchObject({ state: 'connecting-tunnel', tailscale: { funnel: 'ready', publicIngress: { state: 'dns-pending' } } }));
    const url = f.reports.at(-1)!.publicUrl;
    expect(f.reports.some(report => report.state === 'connected')).toBe(false);
    expect(f.mutations()).toHaveLength(2);
    f.probe.mockResolvedValue({ state: 'ready' });
    await vi.waitFor(() => expect(f.reports.at(-1)).toMatchObject({ state: 'connected', publicUrl: url, tailscale: { publicIngress: { state: 'ready' } } }));
    expect(f.mutations()).toHaveLength(2);
    await started.handle.stop();
  });
  it('recovers public TLS automatically even after the initial retry window, without replaying native route changes', async () => {
    const f = fixture(); f.probe.mockResolvedValue({ state: 'tls-error' }); f.retryWindowMs = 50;
    await f.start(undefined, undefined, 20, false);
    await vi.waitFor(() => expect(f.reports.at(-1)).toMatchObject({ state: 'connecting-tunnel', tailscale: { funnel: 'ready', publicIngress: { state: 'tls-error' } } }));
    f.now = 100;
    await vi.waitFor(() => expect(f.reports.at(-1)).toMatchObject({ state: 'tunnel-unavailable', publicUrl: expect.any(String), tailscale: { funnel: 'ready', publicIngress: { state: 'tls-error' } } }));
    const count = f.probe.mock.calls.length;
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(f.probe.mock.calls.length).toBeGreaterThan(count);
    expect(f.mutations()).toHaveLength(2);
    expect(f.reports.some(report => report.state === 'connected')).toBe(false);
    expect(f.reports.at(-1)!.detail).toContain('keep checking automatically');
    f.probe.mockResolvedValue({state:'ready'});
    await vi.waitFor(() => expect(f.reports.at(-1)?.state).toBe('connected'));
    expect(f.mutations()).toHaveLength(2);
  });
  it('returns a cancellable handle during the first probe and ignores an old late success after restart', async () => {
    const f = fixture(); let release!: (value: FunnelPublicResult) => void;
    f.probe.mockImplementationOnce(async () => new Promise(resolve => { release = resolve; }));
    const first = await f.start(undefined, undefined, 20, false);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(f.probe).toHaveBeenCalledTimes(1); // Slow checks cannot overlap.
    const firstSignal = f.probe.mock.calls[0]![1];
    const url = f.reports.at(-1)!.publicUrl;
    await first.handle.stop(); expect(firstSignal.aborted).toBe(true);
    await f.start(first.stateDir, undefined, 60_000);
    expect(f.reports.at(-1)!.publicUrl).toBe(url);
    const before = f.reports.length;
    release({ state: 'ready' }); await new Promise(resolve => setTimeout(resolve, 30));
    expect(f.reports).toHaveLength(before);
  });
  it('revalidates native custody before publishing a slow successful public response', async () => {
    const f = fixture(); let release!: (value: FunnelPublicResult) => void;
    f.probe.mockImplementation(async () => new Promise(resolve => { release = resolve; }));
    await f.start(undefined, undefined, 60_000, false);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const mount = f.mutations()[0]![3]!.slice('--set-path='.length);
    f.current.Web[`${DNS}:443`].Handlers[mount] = { Text: 'foreign replacement' };
    release({ state: 'ready' });
    await vi.waitFor(() => expect(f.reports.at(-1)?.state).toBe('tunnel-unavailable'));
    expect(f.reports.some(report => report.state === 'connected')).toBe(false);
    expect(f.mutations()).toHaveLength(2);
  });
  it.each(['signed-out', 'permission', 'old-version', 'missing-cli'])('reports a concrete %s setup boundary without route mutation', async reason => {
    const f = fixture();
    if (reason === 'signed-out') { f.node.BackendState = 'NeedsLogin'; f.node.AuthURL = 'https://login.tailscale.com/a/private'; }
    if (reason === 'permission') delete f.node.Self.CapMap.funnel;
    if (reason === 'old-version') f.version = '1.50.0';
    await expect(f.start(undefined, reason === 'missing-cli' ? () => '' : undefined)).rejects.toThrow();
    expect(f.mutations()).toHaveLength(0);
    expect(JSON.stringify(f.reports)).not.toContain('/a/private');
    const snapshot = f.reports.at(-1)?.tailscale;
    expect(snapshot?.publicIngress).toBeUndefined();
    if (reason === 'signed-out') expect(snapshot?.account).toBe('signed-out');
    if (reason === 'permission') expect(snapshot?.funnel).toBe('permission-required');
    if (reason === 'missing-cli') expect(snapshot?.cli).toBe('missing');
  });
});
