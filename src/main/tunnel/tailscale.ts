/**
 * System Tailscale Funnel adapter. Native Serve and Funnel share configuration.
 * Never reset it, promote private routes, infer custody from a matching name, or sign in.
 * CLI contract: https://tailscale.com/docs/reference/tailscale-cli/funnel
 * Native proxy strips the mount but preserves Host; tailscale-relay keeps MCP's guard.
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { TailscaleStatus } from '../../shared/types.js';
import { childEnv } from '../exec.js';
import { logInfo, logWarn } from '../logger.js';
import type { TunnelHandle, TunnelStartOptions } from './index.js';
import { locateBinary } from './locate.js';
import { createTailscaleRelay, type TailscaleRelay } from './tailscale-relay.js';

class FunnelSetupError extends Error {}
type Row = Record<string, unknown>;
type NativeConfig = Row & { TCP?: Row; Web?: Row; AllowFunnel?: Row; Foreground?: Row };
export interface FunnelCustody { version: 1; nodeId: string; dnsName: string; port: number; mount: string; proxy: string; previousProxy?: string; previousMetadataProxy?: string; metadata?: true }
interface Dependencies {
  run(binary: string, args: string[]): Promise<string>;
  locate(hint: string): string | null;
  stateDir: string;
  relay(origin: string, publicHost: string, publicMount: string): Promise<TailscaleRelay>;
  watchMs: number;
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
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv() });
    let stdout = '', stderr = '', done = false;
    const finish = (error?: Error) => { if (done) return; done = true; clearTimeout(timer); error ? reject(error) : resolve(stdout); };
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
  const deps: Dependencies = { run: runCli, locate: hint => locateBinary('tailscale', hint), stateDir: app.getPath('userData'), relay: createTailscaleRelay, watchMs: 15_000, ...overrides };
  const check: TailscaleStatus = { cli: 'missing', account: 'unknown', funnel: 'unknown', checkedAt: Date.now(), detail: 'Checking system Tailscale…' };
  const report = (state: 'connecting-tunnel' | 'connected' | 'tunnel-unavailable', detail: string, publicUrl: string | null = null) => {
    check.checkedAt = Date.now(); check.detail = detail;
    opts.report({ state, detail, publicUrl, tailscale: { ...check } });
  };
  const binary = deps.locate(opts.settings.binaryPath);
  if (!binary) { report('tunnel-unavailable', 'Tailscale was not found. Install Tailscale, sign in using its own app, then retry Connect.'); throw new FunnelSetupError(check.detail); }
  check.cli = 'ready'; report('connecting-tunnel', 'Checking Tailscale sign-in and existing Funnel routes…');
  let relay: TailscaleRelay | undefined;
  let custody: FunnelCustody | undefined;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let checking = false;
  let nativeMutation = false;
  const custodyFile = path.join(deps.stateDir, `tailscale-funnel-${createHash('sha256').update(opts.settings.profileId ?? 'default').digest('hex').slice(0, 24)}.json`);
  const readNode = async (): Promise<{ id: string; dnsName: string }> => {
    const status = parse(await deps.run(binary, ['status', '--json']));
    const self = object(status.Self);
    if (status.BackendState !== 'Running' || status.AuthURL) {
      check.account = /NeedsLogin|NoState|NeedsMachineAuth/.test(String(status.BackendState)) || !!status.AuthURL ? 'signed-out' : 'unknown';
      throw new FunnelSetupError('Tailscale is not ready. Sign in/approve this device and bring it online using the Tailscale app, then retry Connect.');
    }
    if (self.Online !== true) throw new FunnelSetupError('Tailscale reports this device offline. Bring it online in Tailscale, then retry Connect.');
    check.account = 'ready';
    const dnsName = typeof self.DNSName === 'string' ? self.DNSName.toLowerCase().replace(/\.$/, '') : '';
    if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+\.ts\.net$/.test(dnsName) || typeof self.ID !== 'string' || !/^[\w-]{1,128}$/.test(self.ID)) {
      throw new FunnelSetupError('Tailscale has no usable device HTTPS name. Enable MagicDNS/HTTPS in your Tailscale account, then retry Connect.');
    }
    const capabilities = new Set([...Object.keys(object(self.CapMap)), ...(Array.isArray(self.Capabilities) ? self.Capabilities : [])]);
    if (!capabilities.has('funnel') || !capabilities.has('https')) {
      check.funnel = 'permission-required';
      throw new FunnelSetupError('Enable HTTPS and Funnel for this device in your Tailscale account, then retry Connect. OneCode does not change tailnet policy.');
    }
    return { id: self.ID, dnsName };
  };
  const readConfig = async (): Promise<NativeConfig> => config(await deps.run(binary, ['funnel', 'status', '--json']));
  const matchesNode = (node: { id: string; dnsName: string }, owned: FunnelCustody): boolean => node.id === owned.nodeId && node.dnsName === owned.dnsName;
  const removeOwned = async (): Promise<void> => {
    if (!custody || !nativeMutation) return;
    try {
      for (const route of ownedRoutes(custody).reverse()) {
        const node = await readNode();
        const current = await readConfig();
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
    const node = await readNode();
    const before = await readConfig();
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
    const finalNode = await readNode();
    const finalBefore = await readConfig();
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
        const liveNode = await readNode();
        const live = await readConfig();
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
    const verify = async (publish = true): Promise<string | undefined> => {
      const liveNode = await readNode();
      const live = await readConfig();
      if (stopped) return;
      if (!custody || !matchesNode(liveNode, custody) || ownedRoutes(custody).some(route => !ownedHandler(live, custody!, route.mount)) || live.AllowFunnel?.[host(custody)] !== true || !same(live.TCP?.[String(custody.port)], { HTTPS: true })) {
        throw new FunnelSetupError('The owned Tailscale Funnel route is not public/current. Reconnect after checking Tailscale; OneCode will not recreate it automatically.');
      }
      if (!same(unrelatedRoutes(before, custody), unrelatedRoutes(live, custody))) {
        throw new FunnelSetupError('Other Tailscale routes changed. OneCode will not overwrite or restore another service’s configuration. Inspect Tailscale before reconnecting.');
      }
      check.funnel = 'ready';
      const origin = `https://${custody.dnsName}${custody.port === 443 ? '' : `:${custody.port}`}`;
      const publicUrl = `${origin}${custody.mount}${local.pathname}`;
      if (publish) report('connected', 'OneCode Funnel route verified. Use the HTTPS connector URL below; Gemini access is verified when a request arrives.', publicUrl);
      return publicUrl;
    };
    const publicUrl = await verify(false);
    delete custody.previousProxy;
    delete custody.previousMetadataProxy;
    await persist();
    report('connected', 'OneCode Funnel route verified. Use the HTTPS connector URL below; Gemini access is verified when a request arrives.', publicUrl);
    timer = setInterval(() => {
      if (stopped || checking) return;
      checking = true;
      void verify().catch(error => {
        if (stopped) return;
        if (check.funnel !== 'permission-required') check.funnel = 'error';
        report('tunnel-unavailable', error instanceof FunnelSetupError ? error.message : describeFailure(error));
      }).finally(() => { checking = false; });
    }, deps.watchMs);
    timer.unref?.();
    return { stop: async () => { if (stopped) return; stopped = true; clearInterval(timer); await removeOwned(); await relay?.stop(); } };
  } catch (error) {
    clearInterval(timer);
    await removeOwned();
    await relay?.stop();
    if (check.funnel !== 'permission-required') check.funnel = 'error';
    if (!check.version) check.cli = 'error';
    const message = error instanceof FunnelSetupError ? error.message : describeFailure(error);
    report('tunnel-unavailable', message);
    throw new FunnelSetupError(message);
  }
}
