/**
 * System Tailscale Funnel adapter. Native Serve and Funnel share configuration.
 * Never reset it, promote private routes, infer custody from a matching name, or sign in.
 * CLI contract: https://tailscale.com/docs/reference/tailscale-cli/funnel
 * Native proxy strips the mount but preserves Host; tailscale-relay keeps MCP's guard.
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import type { TailscaleStatus } from '../../shared/types.js';
import { childEnv } from '../exec.js';
import { logInfo, logWarn } from '../logger.js';
import type { TunnelHandle, TunnelStartOptions } from './index.js';
import { locateBinary } from './locate.js';
import { createTailscaleRelay, type TailscaleRelay } from './tailscale-relay.js';
import { probeFunnelPublic, type FunnelPublicResult } from './tailscale-public.js';
import { withTailscaleMutation } from './tailscale-mutation.js';
import { TailscaleNotReady, TailscaleSetupRequired, tailscalePrerequisites, readTailscaleDaemon } from './tailscale-prerequisites.js';
import { requestTailscaleSetup } from './tailscale-setup.js';
import { restartWindowsTailscale } from './tailscale-repair.js';

class FunnelSetupError extends Error {}
type Row = Record<string, unknown>;
type NativeConfig = Row & { TCP?: Row; Web?: Row; AllowFunnel?: Row; Foreground?: Row };
export interface FunnelCustody { version: 1; nodeId: string; dnsName: string; port: number; mount: string; proxy: string; previousProxy?: string; previousMetadataProxy?: string; metadata?: true }
interface Dependencies {
  run(binary: string, args: string[]): Promise<string>;
  locate(hint: string): string | null;
  platform: NodeJS.Platform;
  username(): string;
  stateDir: string;
  relay(origin: string, publicHost: string, publicMount: string): Promise<TailscaleRelay>;
  probe(url: string, signal: AbortSignal): Promise<FunnelPublicResult>;
  now(): number;
  retryWindowMs: number;
  watchMs: number;
  repair(): Promise<void>;
}
const PORTS = [443, 8443, 10000];
export const FUNNEL_METADATA_PREFIX = '/.well-known/oauth-protected-resource';
const row = (value: unknown): value is Row => value !== null && typeof value === 'object' && !Array.isArray(value);
const object = (value: unknown): Row => row(value) ? value : {};
const empty = (value: unknown): boolean => Object.keys(object(value)).length === 0;
const same = (a: unknown, b: unknown): boolean => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
function canonical(value: unknown): unknown {
  return Array.isArray(value) ? value.map(canonical) : row(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
}
function parse(text: string): Row {
  try { const value: unknown = JSON.parse(text); if (row(value)) return value; } catch { /* fixed error below */ }
  throw new FunnelSetupError('Tailscale returned an unreadable status. Update Tailscale and retry Connect.');
}
function config(text: string): NativeConfig {
  const value = parse(text);
  for (const key of ['TCP', 'Web', 'AllowFunnel', 'Foreground', 'Services']) {
    if (value[key] !== undefined && value[key] !== null && !row(value[key])) throw new FunnelSetupError('Tailscale returned an unsupported Serve configuration. No routes were changed.');
  }
  return value as NativeConfig;
}
function normalizeProxy(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && !!url.port && url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password
      ? url.origin : null;
  } catch { return null; }
}
function validCustody(value: unknown): value is FunnelCustody {
  return row(value) && value.version === 1 && typeof value.nodeId === 'string' && /^[\w-]{1,128}$/.test(value.nodeId) &&
    typeof value.dnsName === 'string' && /^[a-z0-9-]+(?:\.[a-z0-9-]+)+\.ts\.net$/.test(value.dnsName) &&
    typeof value.port === 'number' && PORTS.includes(value.port) && typeof value.mount === 'string' && /^\/onecode-[0-9a-f]{32}$/.test(value.mount) &&
    normalizeProxy(value.proxy) === value.proxy && (value.previousProxy === undefined || normalizeProxy(value.previousProxy) === value.previousProxy) &&
    (value.previousMetadataProxy === undefined || normalizeProxy(value.previousMetadataProxy) === value.previousMetadataProxy) &&
    (value.metadata === undefined || value.metadata === true);
}
function host(custody: FunnelCustody): string { return `${custody.dnsName}:${custody.port}`; }
function handlers(value: NativeConfig, custody: FunnelCustody): Row { return object(object(value.Web?.[host(custody)]).Handlers); }
function ownedRoutes(custody: FunnelCustody): Array<{ mount: string; proxy: string }> {
  return [{ mount: custody.mount, proxy: custody.proxy }, ...(custody.metadata ? [{ mount: FUNNEL_METADATA_PREFIX + custody.mount, proxy: custody.proxy + FUNNEL_METADATA_PREFIX }] : [])];
}
function ownedHandler(value: NativeConfig, custody: FunnelCustody, mount = custody.mount): boolean {
  const route = ownedRoutes(custody).find(route => route.mount === mount);
  return !!route && same(handlers(value, custody)[mount], { Proxy: route.proxy });
}
function knownHandler(value: NativeConfig, custody: FunnelCustody, mount: string): boolean {
  if (ownedHandler(value, custody, mount)) return true;
  const previous = mount === custody.mount ? custody.previousProxy : custody.metadata && mount === FUNNEL_METADATA_PREFIX + custody.mount ? custody.previousMetadataProxy : undefined;
  return !!previous && same(handlers(value, custody)[mount], { Proxy: previous + (mount === custody.mount ? '' : FUNNEL_METADATA_PREFIX) });
}
function unrelatedRoutes(value: NativeConfig, custody: FunnelCustody): NativeConfig {
  const copy = JSON.parse(JSON.stringify(value)) as NativeConfig;
  const web = object(copy.Web?.[host(custody)]);
  const routes = object(web.Handlers);
  for (const route of ownedRoutes(custody)) delete routes[route.mount];
  if (empty(routes)) {
    delete copy.Web?.[host(custody)];
    delete copy.TCP?.[String(custody.port)];
    delete copy.AllowFunnel?.[host(custody)];
  }
  for (const key of ['TCP', 'Web', 'AllowFunnel', 'Services', 'Foreground']) if (empty(copy[key])) delete copy[key];
  return copy;
}
/** A newly public listener must contain no other routes (including private/foreground ones). */
export function assertFunnelRouteSafe(value: NativeConfig, custody: FunnelCustody, previous?: FunnelCustody): void {
  if (!empty(value.Foreground)) throw new FunnelSetupError('Tailscale has foreground Serve/Funnel sessions. Stop those sessions yourself before connecting OneCode.');
  const port = String(custody.port);
  const tcp = object(value.TCP?.[port]);
  if (!empty(tcp) && !same(tcp, { HTTPS: true })) throw new FunnelSetupError('The reserved Funnel port has another listener. OneCode did not change it.');
  for (const key of Object.keys(value.Web ?? {})) {
    if (key.endsWith(`:${port}`) && key !== host(custody)) throw new FunnelSetupError('The reserved Funnel port belongs to another hostname. OneCode did not change it.');
  }
  const routes = handlers(value, custody);
  const mounts = ownedRoutes(custody).map(route => route.mount);
  for (const mount of mounts) {
    if (routes[mount] !== undefined && (!previous || !knownHandler(value, previous, mount))) throw new FunnelSetupError('The OneCode Funnel path was changed outside this app. No route was overwritten.');
  }
  if (value.AllowFunnel?.[host(custody)] !== true && Object.keys(routes).some(mount => !mounts.includes(mount))) {
    throw new FunnelSetupError('This listener has private Serve routes. OneCode will not make them public.');
  }
  for (const mount of Object.keys(routes)) {
    // A public root catchall is a fallback, not a conflicting more-specific route.
    // All other ancestor/descendant conflicts remain an explicit refusal.
    if (!mounts.includes(mount) && mount !== '/' && mounts.some(owned => mount.startsWith(`${owned}/`) || owned.startsWith(`${mount.replace(/\/$/, '')}/`))) {
      throw new FunnelSetupError('An existing Serve path overlaps the OneCode mount. No route was changed.');
    }
  }
}
function freePort(value: NativeConfig): number {
  const port = PORTS.find(candidate => !value.TCP?.[String(candidate)] &&
    !Object.keys(value.Web ?? {}).some(key => key.endsWith(`:${candidate}`)) &&
    !Object.keys(value.AllowFunnel ?? {}).some(key => key.endsWith(`:${candidate}`)));
  if (!port) throw new FunnelSetupError('Tailscale ports 443, 8443 and 10000 already have routes. Free a port yourself; OneCode did not change them.');
  return port;
}
function choosePort(value: NativeConfig, custody: FunnelCustody, previous?: FunnelCustody): number {
  if (previous?.port === 443) return 443;
  const desired = { ...custody, port: 443 };
  const tcp = value.TCP?.['443'];
  const no443State = tcp === undefined && !Object.keys(value.Web ?? {}).some(key => key.endsWith(':443')) && !Object.keys(value.AllowFunnel ?? {}).some(key => key.endsWith(':443'));
  let usable = no443State || (same(tcp, { HTTPS: true }) && value.AllowFunnel?.[host(desired)] === true);
  if (usable) {
    try { assertFunnelRouteSafe(value, desired); } catch { usable = false; }
  }
  if (usable) {
    if (previous && ownedRoutes(previous).some(route => handlers(value, previous)[route.mount] !== undefined)) {
      throw new FunnelSetupError('Disconnect the previous OneCode connection before moving its saved route to port 443. No existing mount was moved or removed.');
    }
    return 443;
  }
  return previous?.port ?? freePort(value);
}
function describeFailure(error: unknown): string {
  const raw = error instanceof Error ? error.message : '';
  if (/access denied|permission denied|not permitted|requires root|administrator|403/i.test(raw)) return 'Tailscale denied permission. Review the Tailscale daemon/operator and Funnel policy, then retry Connect.';
  if (/funnel.*(not enabled|not allowed|enable|permission)|https.*(enable|disabled)|capabilit/i.test(raw)) return 'Enable HTTPS and Funnel for this device in your Tailscale account, then retry Connect. OneCode does not change tailnet policy.';
  if (/timeout|timed out/i.test(raw)) return 'Tailscale did not finish in time. Inspect its status before retrying; OneCode will not replay a route change automatically.';
  return 'Tailscale could not configure or verify the owned route. Check Tailscale sign-in, daemon access and Funnel policy, then retry Connect.';
}
/** Bounded, hidden native subprocess; no shell, auth key, raw-output logging or daemon signals. */
async function runCli(binary: string, args: string[]): Promise<string> {
  const startedAt = performance.now();
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...childEnv(), TAILSCALE_BE_CLI: '1' } });
    let stdout = '', stderr = '', done = false;
    const finish = (error?: Error) => {
      if (done) return; done = true; clearTimeout(timer);
      const elapsedMs = Math.round(performance.now() - startedAt);
      // Fixed command categories only: args/output contain private mounts and device data.
      if (elapsedMs >= 1000) logInfo(`OneCode Funnel slow CLI command=${args[0] === 'version' ? 'version' : args[0] === 'status' ? 'node-status' : args[1] === 'status' ? 'route-status' : 'route-change'} elapsedMs=${elapsedMs} outcome=${error ? 'error' : 'ok'}`);
      error ? reject(error) : resolve(stdout);
    };
    const timer = setTimeout(() => { child.kill(); finish(new Error('Tailscale command timed out')); }, 30_000);
    for (const [stream, name] of [[child.stdout, 'out'], [child.stderr, 'err']] as const) stream.on('data', chunk => {
      if (name === 'out') stdout += String(chunk); else stderr += String(chunk);
      if (stdout.length + stderr.length > 4_000_000) { child.kill(); finish(new Error('Tailscale output exceeded the limit')); }
    });
    child.once('error', () => finish(new Error('Tailscale executable could not start')));
    child.once('close', code => finish(code === 0 ? undefined : new Error(stderr || 'Tailscale command failed')));
  });
}

export async function startTailscale(opts: TunnelStartOptions, overrides: Partial<Dependencies> = {}): Promise<TunnelHandle> {
  let stopped = false, active: TunnelHandle | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  const attempt = async (initial = false): Promise<void> => {
    if (stopped) return;
    try {
      const handle = await withTailscaleMutation(() => startTailscaleOwned({ ...opts, report: report => { if (!stopped) opts.report(report); } }, overrides));
      if (stopped) await handle.stop(); else active = handle;
    } catch (error) {
      if (stopped) return;
      if (!(error instanceof TailscaleSetupRequired) && !(error instanceof TailscaleNotReady)) { if (initial) throw error; return; }
      if (error instanceof TailscaleSetupRequired) void requestTailscaleSetup(error.setup);
      // No route mutation has started. Re-read installation/account/capabilities;
      // never replay an uncertain CLI mutation or recreate a replaced route.
      timer = setTimeout(() => { void attempt().catch(() => undefined); }, overrides.watchMs ?? 5_000); timer.unref?.();
    }
  };
  await attempt(true);
  return {
    stop: async () => { stopped = true; clearTimeout(timer); await active?.stop(); },
    repairTailscale: async () => {
      if (stopped || !active?.repairTailscale) throw new Error('The Tailscale connection is no longer active.');
      await active.repairTailscale();
    }
  };
}
async function startTailscaleOwned(opts: TunnelStartOptions, overrides: Partial<Dependencies>): Promise<TunnelHandle> {
  const startedAt = performance.now();
  const startupTiming = (stage: string) => logInfo(`OneCode Funnel startup stage=${stage} elapsedMs=${Math.round(performance.now() - startedAt)}`);
  const deps: Dependencies = { run: runCli, locate: hint => locateBinary('tailscale', hint), stateDir: app.getPath('userData'), relay: createTailscaleRelay,
    platform: process.platform, username: () => os.userInfo().username,
    probe: (url, signal) => probeFunnelPublic(url, signal, {}, opts.discoveryHeaders), now: Date.now, retryWindowMs: 10 * 60_000, watchMs: 15_000, repair: restartWindowsTailscale, ...overrides };
  let repairing: Promise<void> | null = null, transportEpoch = 0;
  const check: TailscaleStatus = { cli: 'missing', account: 'unknown', funnel: 'unknown', checkedAt: Date.now(), detail: 'Checking system Tailscale…' };
  const report = (state: 'connecting-tunnel' | 'connected' | 'offline' | 'tunnel-unavailable', detail: string, publicUrl: string | null = null) => {
    check.canRepair = process.platform === 'win32' && !repairing && check.funnel === 'ready' && check.publicIngress?.state === 'tls-error';
    check.checkedAt = Date.now(); check.detail = detail;
    opts.report({ state, detail, publicUrl, tailscale: { ...check } });
  };
  const binary = deps.locate(opts.settings.binaryPath);
  if (!binary) {
    const problem = new TailscaleSetupRequired('install', 'Tailscale could not be located. Install it or choose its executable in Advanced settings; OneCode will detect it automatically.');
    check.setup = problem.setup; report('connecting-tunnel', problem.message); throw problem;
  }
  check.cli = 'ready'; report('connecting-tunnel', 'Checking Tailscale sign-in and existing Funnel routes…');
  let relay: TailscaleRelay | undefined;
  let custody: FunnelCustody | undefined;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let checking = false;
  const publicProbe = new AbortController();
  let nativeMutation = false;
  const custodyFile = path.join(deps.stateDir, `tailscale-funnel-${createHash('sha256').update(opts.settings.profileId ?? 'default').digest('hex').slice(0, 24)}.json`);
  const readNode = async (): Promise<{ id: string; dnsName: string }> => {
    const status = parse(await readTailscaleDaemon(() => deps.run(binary, ['status', '--json'])));
    try { const node = tailscalePrerequisites(status, true); check.account = 'ready'; delete check.setup; return node; }
    catch (error) {
      if (error instanceof TailscaleSetupRequired) {
        check.setup = error.setup;
        check.account = error.setup.step === 'login' ? 'signed-out' : 'ready';
        if (error.setup.step === 'dns' || error.setup.step === 'funnel') check.funnel = 'permission-required';
      }
      throw error;
    }
  };
  const readConfig = async (): Promise<NativeConfig> => config(await readTailscaleDaemon(() => deps.run(binary, ['funnel', 'status', '--json'])));
  // These are independent read-only daemon queries. Serial CLI process startup is
  // costly on Windows, especially immediately after laptop sign-in. Keep every
  // custody check and all route mutations ordered at their existing boundaries.
  const readNative = () => Promise.all([readNode(), readConfig()]);
  const matchesNode = (node: { id: string; dnsName: string }, owned: FunnelCustody): boolean => node.id === owned.nodeId && node.dnsName === owned.dnsName;
  const removeOwned = async (): Promise<void> => {
    if (!custody || !nativeMutation) return;
    try {
      for (const route of ownedRoutes(custody).reverse()) {
        const [node, current] = await readNative();
        if (!matchesNode(node, custody) || !empty(current.Foreground) || !knownHandler(current, custody, route.mount)) {
          logWarn('OneCode Funnel cleanup skipped a path whose native custody changed.'); continue;
        }
        // Explicit path is essential: without it native off removes all handlers on a port.
        await deps.run(binary, ['funnel', `--https=${custody.port}`, `--set-path=${route.mount}`, 'off']);
      }
      logInfo('OneCode Funnel: cleanup touched only custody-matched paths.');
    } catch { logWarn('OneCode Funnel cleanup could not verify/remove its route; no reset or retry was attempted.'); }
  };
  try {
    const version = /^(\d+)\.(\d+)\.(\d+)/.exec((await deps.run(binary, ['version'])).trim());
    if (!version || Number(version[1]) < 1 || (Number(version[1]) === 1 && Number(version[2]) < 52)) throw new FunnelSetupError('Install Tailscale 1.52 or newer before using OneCode Funnel.');
    check.version = version[0];
    startupTiming('cli-ready');
    if (deps.platform === 'linux') {
      const username = deps.username().trim();
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(username)) throw new FunnelSetupError('The current Linux user name cannot be authorized as a Tailscale operator.');
      const operator = (await readTailscaleDaemon(() => deps.run(binary, ['get', 'operator']))).trim();
      if (operator !== username) {
        const problem = new TailscaleSetupRequired('operator', operator
          ? `Tailscale currently authorizes “${operator}” for route changes. Approve this Linux user before OneCode publishes its Funnel path.`
          : 'Tailscale needs to authorize this Linux user before OneCode can publish its Funnel path. Approve the system authorization prompt.');
        check.setup = problem.setup; check.account = 'ready'; check.funnel = 'permission-required';
        report('connecting-tunnel', problem.message);
        throw problem;
      }
    }
    const [node, before] = await readNative();
    startupTiming('native-ready');
    let previous: FunnelCustody | undefined;
    try {
      const stored: unknown = JSON.parse(await fs.readFile(custodyFile, 'utf8'));
      if (!validCustody(stored)) throw new FunnelSetupError('invalid-custody');
      previous = stored;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new FunnelSetupError('OneCode Funnel custody is unreadable. No existing route was claimed or changed.');
    }
    if (previous && !matchesNode(node, previous)) throw new FunnelSetupError('The Tailscale device/name changed. OneCode did not move or delete the old route. Review the old Funnel route before resetting this app’s route custody.');
    const local = new URL(opts.localUrl);
    if (local.protocol !== 'http:' || local.hostname !== '127.0.0.1' || !local.port) throw new FunnelSetupError('OneCode Funnel requires its loopback MCP server.');
    const base: FunnelCustody = { ...(previous ?? { version: 1, nodeId: node.id, dnsName: node.dnsName, port: 443, mount: `/onecode-${randomBytes(16).toString('hex')}`, proxy: 'http://127.0.0.1:1' }), metadata: true };
    const reserved = { ...base, port: choosePort(before, base, previous) };
    const samePortPrevious = previous?.port === reserved.port ? previous : undefined;
    assertFunnelRouteSafe(before, reserved, samePortPrevious);
    relay = await deps.relay(local.origin, host(reserved), reserved.mount);
    custody = { ...reserved, proxy: relay.origin };
    delete custody.previousProxy; delete custody.previousMetadataProxy;
    if (samePortPrevious) {
      // Each path may be at a different stage after a crash between the two updates.
      // Retain only targets proved by the previous receipt AND actually observed now.
      const main = object(handlers(before, samePortPrevious)[samePortPrevious.mount]).Proxy;
      const metadata = object(handlers(before, samePortPrevious)[FUNNEL_METADATA_PREFIX + samePortPrevious.mount]).Proxy;
      if (typeof main === 'string') custody.previousProxy = main;
      if (typeof metadata === 'string') custody.previousMetadataProxy = metadata.slice(0, -FUNNEL_METADATA_PREFIX.length);
    }
    if (normalizeProxy(custody.proxy) !== custody.proxy) throw new FunnelSetupError('OneCode Funnel relay address was invalid.');
    const [finalNode, finalBefore] = await readNative();
    if (!matchesNode(finalNode, custody) || !same(before, finalBefore)) throw new FunnelSetupError('Tailscale routes changed during preparation. Nothing was overwritten; inspect the current routes before retrying.');
    assertFunnelRouteSafe(finalBefore, custody, samePortPrevious);
    // Persist exact intent before the one native change. Crashes/ambiguous CLI exits
    // retain both known targets, so a failed update cannot erase the old route custody.
    await fs.mkdir(deps.stateDir, { recursive: true });
    const temporary = `${custodyFile}.tmp`;
    const persist = async () => {
      await fs.writeFile(temporary, JSON.stringify(custody), { encoding: 'utf8', mode: 0o600 });
      await fs.rename(temporary, custodyFile);
    };
    await persist();
    if (!matchesNode(await readNode(), custody)) throw new FunnelSetupError('The Tailscale device changed before route publication. No route was configured.');
    nativeMutation = true;
    const installed = new Set<string>();
    for (const route of ownedRoutes(custody)) {
      if (installed.size) {
        const [liveNode, live] = await readNative();
        if (!matchesNode(liveNode, custody) || !empty(live.Foreground) ||
            !same(unrelatedRoutes(before, custody), unrelatedRoutes(live, custody)) ||
            ownedRoutes(custody).some(expected => installed.has(expected.mount)
              ? !ownedHandler(live, custody!, expected.mount)
              : handlers(live, custody!)[expected.mount] !== undefined && (!samePortPrevious || !knownHandler(live, samePortPrevious, expected.mount)))) {
          throw new FunnelSetupError('Tailscale routes changed between the owned path updates. No other route was overwritten.');
        }
      }
      await deps.run(binary, ['funnel', '--bg', `--https=${custody.port}`, `--set-path=${route.mount}`, '--yes', route.proxy]);
      installed.add(route.mount);
    }
    let published = false;
    const verifyNative = async (): Promise<string | undefined> => {
      const [liveNode, live] = await readNative();
      if (stopped) return;
      if (!custody || !matchesNode(liveNode, custody) || ownedRoutes(custody).some(route => !ownedHandler(live, custody!, route.mount)) || live.AllowFunnel?.[host(custody)] !== true || !same(live.TCP?.[String(custody.port)], { HTTPS: true })) {
        throw new FunnelSetupError('The owned Tailscale Funnel route is not public/current. Reconnect after checking Tailscale; OneCode will not recreate it automatically.');
      }
      assertFunnelRouteSafe(live, custody, custody);
      // Publication must preserve all other routes. Later liveness owns only this port;
      // independent private Serve ports may be added or removed while MCP stays connected.
      if (!published && !same(unrelatedRoutes(before, custody), unrelatedRoutes(live, custody))) {
        throw new FunnelSetupError('Other Tailscale routes changed. OneCode will not overwrite or restore another service’s configuration. Inspect Tailscale before reconnecting.');
      }
      check.funnel = 'ready';
      const origin = `https://${custody.dnsName}${custody.port === 443 ? '' : `:${custody.port}`}`;
      const publicUrl = `${origin}${custody.mount}${local.pathname}`;
      return publicUrl;
    };
    const publicUrl = await verifyNative();
    delete custody.previousProxy;
    delete custody.previousMetadataProxy;
    await persist();
    published = true;
    check.publicIngress = { state: 'checking', checkedAt: null };
    startupTiming('routes-configured');
    report('connecting-tunnel', 'The owned Funnel route is configured. Checking its exact connector through public DNS and HTTPS…', publicUrl);
    let failedSince: number | null = null, failures = 0, firstPublicReady = false, lastPublicReadyAt: number | undefined;
    let previousPublicState: FunnelPublicResult['state'] | undefined;
    const details: Record<Exclude<FunnelPublicResult['state'], 'ready'>, string> = {
      'dns-pending': 'Public DNS has not published this device yet. Tailscale says propagation can take up to 10 minutes.',
      'dns-error': 'Public DNS checks could not verify an ingress address. OneCode is checking Cloudflare and Google DNS automatically.',
      'tls-error': 'Public DNS resolves, but verified TLS to the Funnel ingress failed. Local Tailscale readiness does not prove public reachability.',
      'timeout': 'The public connection check timed out. A slow response does not prove a TLS failure; OneCode will check again without restarting Tailscale.',
      'http-error': 'Public HTTPS answered, but the exact connector metadata path did not return HTTP 200. Check the current OneCode URL and Funnel routing.',
      'metadata-error': 'Public HTTPS did not return metadata for this exact current connector. A different or stale mount cannot verify this connection.',
      'mcp-error': 'Public HTTPS works, but the MCP initialize handshake failed. Keep OneCode running and use the current Core URL after this check passes.'
    };
    const cycle = async (initial = false): Promise<void> => {
      if (stopped || checking || repairing || !publicUrl) return;
      const epoch = transportEpoch;
      checking = true;
      let delay: number | undefined = deps.watchMs;
      try {
        if (!initial) await verifyNative();
        if (stopped) return;
        const probeStartedAt = performance.now();
        const result = await deps.probe(publicUrl, publicProbe.signal);
        const probeElapsedMs = Math.round(performance.now() - probeStartedAt);
        if (stopped || epoch !== transportEpoch) return;
        // A slow public result cannot publish a route whose custody changed meanwhile.
        await verifyNative();
        if (stopped || epoch !== transportEpoch) return;
        if (result.state === 'ready') lastPublicReadyAt = Date.now();
        check.publicIngress = { state: result.state, checkedAt: Date.now(), ...(lastPublicReadyAt === undefined ? {} : { lastReadyAt: lastPublicReadyAt }) };
        if (result.state !== previousPublicState) {
          logInfo(`OneCode Funnel public check state=${result.state} probeElapsedMs=${probeElapsedMs} connectionAgeMs=${Math.round(performance.now() - startedAt)}`);
          previousPublicState = result.state;
        }
        if (result.state === 'ready') {
          if (!firstPublicReady) { firstPublicReady = true; startupTiming('public-ready'); }
          failedSince = null; failures = 0;
          report('connected', 'The exact OneCode connector is reachable through public DNS and verified HTTPS. Provider installation and tool use are verified separately.', publicUrl);
        } else {
          failedSince ??= deps.now(); failures++;
          if (deps.now() - failedSince >= deps.retryWindowMs) {
            report('tunnel-unavailable', `${details[result.state]} OneCode will keep checking automatically; the saved route and URL were retained.`, publicUrl);
            delay = deps.watchMs;
          } else {
            // Before the first successful public handshake, Setup is still honestly
            // connecting. After one successful handshake, however, a single DNS/TLS
            // miss is only a health-check miss: the native route still has exact custody
            // and may be serving provider traffic at this very moment. Demoting the whole
            // connection to `connecting-tunnel` here used to withdraw Core publication,
            // clear the provider route and stall browser delivery even while live MCP
            // requests continued returning HTTP 200. Keep an established connector live
            // throughout the bounded retry window; `publicIngress` still carries the
            // degraded probe state for diagnostics. Only a sustained failure below, or a
            // failed native-custody verification, is authority to withdraw it.
            const transientState = firstPublicReady ? 'connected' : 'connecting-tunnel';
            const transientDetail = firstPublicReady
              ? `${details[result.state]} The established connector remains published while OneCode rechecks it.`
              : `${details[result.state]} OneCode will recheck without changing the configured routes.`;
            report(transientState, transientDetail, publicUrl);
            delay = Math.max(1, Math.round(Math.min(deps.watchMs, deps.watchMs / 3 * 2 ** Math.min(failures - 1, 2))));
          }
        }
      } catch (error) {
        if (stopped || epoch !== transportEpoch) return;
        check.publicIngress = undefined;
        if (check.funnel !== 'permission-required') check.funnel = 'error';
        report('tunnel-unavailable', error instanceof FunnelSetupError || error instanceof TailscaleNotReady || error instanceof TailscaleSetupRequired ? error.message : describeFailure(error));
      } finally {
        checking = false;
        if (!stopped && !repairing && delay !== undefined) { timer = setTimeout(() => void cycle(), delay); timer.unref?.(); }
      }
    };
    // Return the existing handle before networking so Disconnect can abort the first probe.
    void cycle(true);
    return {
      stop: async () => { if (stopped) return; stopped = true; publicProbe.abort(); clearTimeout(timer); await withTailscaleMutation(removeOwned); await relay?.stop(); },
      repairTailscale: () => {
        if (repairing) return repairing;
        let started = false;
        repairing = (async () => {
          if (stopped || check.publicIngress?.state !== 'tls-error') throw new Error('A current public TLS failure is required before repairing Tailscale.');
          await withTailscaleMutation(async () => { await verifyNative(); if (stopped) throw new Error('The Tailscale connection was closed.'); });
          if (stopped || check.publicIngress?.state !== 'tls-error') throw new Error('The connection changed while repair was being prepared. Check its current status.');
          started = true; transportEpoch++; clearTimeout(timer);
          check.publicIngress = { state: 'checking', checkedAt: null };
          report('connecting-tunnel', 'Waiting for Windows administrator consent to restart Tailscale. Saved routes and connector URLs are retained.', publicUrl);
          await deps.repair();
          if (!stopped) report('connecting-tunnel', 'Tailscale restarted. Verifying the existing connector through public DNS, HTTPS and MCP…', publicUrl);
        })().catch(error => {
          if (!stopped && started) {
            check.publicIngress = { state: 'tls-error', checkedAt: Date.now() };
            report('tunnel-unavailable', 'The public connection repair was not confirmed. Check Tailscale before trying Repair public connection again.', publicUrl);
          }
          throw error;
        }).finally(() => {
          repairing = null;
          if (!stopped && started) { timer = setTimeout(() => void cycle(), 0); timer.unref?.(); }
        });
        return repairing;
      }
    };
  } catch (error) {
    publicProbe.abort(); clearTimeout(timer);
    check.publicIngress = undefined;
    await removeOwned();
    await relay?.stop();
    if (check.funnel !== 'permission-required') check.funnel = 'error';
    if (!check.version) check.cli = 'error';
    const pendingSetup = (error instanceof TailscaleSetupRequired || error instanceof TailscaleNotReady) && !nativeMutation;
    const message = error instanceof FunnelSetupError || error instanceof TailscaleSetupRequired || error instanceof TailscaleNotReady ? error.message : describeFailure(error);
    report(pendingSetup ? 'connecting-tunnel' : 'tunnel-unavailable', message);
    if (pendingSetup) throw error;
    throw new FunnelSetupError(message);
  }
}
