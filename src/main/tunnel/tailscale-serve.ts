/** Private Serve custody is separate from provider MCP Funnel custody. No reset or Funnel mutation. */
import { execFile } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { locateBinary } from './locate.js';
import { readDurable, writeDurableNow } from '../durable.js';
import { withTailscaleMutation } from './tailscale-mutation.js';
import { getConfig } from '../config.js';
import { TailscaleNotReady, TailscaleSetupRequired, tailscalePrerequisites, readTailscaleDaemon } from './tailscale-prerequisites.js';

type Row = Record<string, unknown>;
const object = (v: unknown): Row => v && typeof v === 'object' && !Array.isArray(v) ? v as Row : {};
export const REMOTE_SERVE_PORT = 8444;
interface Custody { version: 1; nodeId: string; host: string; proxy: string }
const portOf = (host: string): number => Number(host.slice(host.lastIndexOf(':') + 1));
function occupied(config: Row, port: number): boolean {
  return Object.hasOwn(object(config.TCP), String(port)) ||
    ['Web', 'AllowFunnel'].some(key => Object.keys(object(config[key])).some(name => name.endsWith(`:${port}`))) ||
    Object.values(object(config.Foreground)).some(value => occupied(object(value), port));
}
function freePort(config: Row): number {
  for (let port = REMOTE_SERVE_PORT; port <= 65535; port++) if (!occupied(config, port)) return port;
  for (let port = 1024; port < REMOTE_SERVE_PORT; port++) if (!occupied(config, port)) return port;
  throw new Error('No free Tailscale Serve port is available.');
}
interface Dependencies { run(args: string[]): Promise<string>; read(): Promise<Custody | null>; write(value: Custody | null): Promise<void> }
const nativeRun = (args: string[]): Promise<string> => new Promise((resolve, reject) => {
  const tunnel = getConfig().tunnel;
  const binary = locateBinary('tailscale', tunnel?.kind === 'tailscale' ? tunnel.binaryPath : undefined);
  if (!binary) { reject(new TailscaleSetupRequired('install', 'Tailscale could not be located. Install it or choose its executable in Advanced settings; OneCode will continue automatically.')); return; }
  execFile(binary, args, { windowsHide: true, timeout: 20_000, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, TAILSCALE_BE_CLI: '1' } }, (error, stdout, stderr) => {
    if (!error) { resolve(stdout); return; }
    const failure = new Error('Tailscale Serve could not complete. Check that Tailscale is running and this user can access it.');
    // Raw CLI errors can contain private device data. Classify read-only failures,
    // then return only fixed text; route mutations are never retryable here.
    if (args[0] === 'status' || args[1] === 'status')
      void readTailscaleDaemon(() => Promise.reject(new Error(stderr || (error.killed ? 'Tailscale command timed out' : error.message))))
        .catch(cause => reject(cause instanceof TailscaleNotReady ? cause : failure));
    else reject(failure);
  });
});
const defaults: Dependencies = { run: nativeRun, read: () => readDurable<Custody>('remote-serve', { strict: true }), write: value => writeDurableNow('remote-serve', value) };
export class RemoteRouteConflict extends Error {}
function parse(text: string): Row { return object(JSON.parse(text)); }
function routes(config: Row, host: string): Row { return object(object(object(config.Web)[host]).Handlers); }
function safe(config: Row, custody: Custody, emptyAllowed: boolean): void {
  const port = portOf(custody.host);
  if (Object.values(object(config.Foreground)).some(value => occupied(object(value), port))) throw new RemoteRouteConflict('The remote Serve port belongs to a foreground route.');
  const tcp = object(object(config.TCP)[String(port)]);
  const names = Object.keys(object(config.Web)).filter(name => name.endsWith(`:${port}`));
  if (Object.entries(object(config.AllowFunnel)).some(([name, enabled]) => name.endsWith(`:${port}`) && enabled !== false))
    throw new RemoteRouteConflict('Remote access refuses a public Funnel listener.');
  if (!names.length && !Object.keys(tcp).length && emptyAllowed) return;
  if (names.length !== 1 || names[0] !== custody.host || !isDeepStrictEqual(tcp, { HTTPS: true }) ||
      !isDeepStrictEqual(routes(config, custody.host), { '/': { Proxy: custody.proxy } })) throw new RemoteRouteConflict('The remote Serve port belongs to another route. No routes were changed.');
}
function unrelated(config: Row, host: string): Row {
  const copy = structuredClone(config); const web = object(copy.Web); delete web[host];
  const tcp = object(copy.TCP); delete tcp[String(portOf(host))];
  const funnel = object(copy.AllowFunnel); delete funnel[host];
  for (const key of ['Web', 'TCP', 'AllowFunnel']) if (!Object.keys(object(copy[key])).length) delete copy[key];
  return copy;
}
export class PrivateServe {
  private custody: Custody | null = null;
  constructor(private deps: Dependencies = defaults) {}
  private async inspect(): Promise<{ node: Row; config: Row; status: Row }> {
    const [status, config] = await Promise.all([readTailscaleDaemon(() => this.deps.run(['status', '--json'])), readTailscaleDaemon(() => this.deps.run(['serve', 'status', '--json']))]);
    const state = parse(status);
    tailscalePrerequisites(state, false);
    return { node: object(state.Self), config: parse(config), status: state };
  }
  start(proxy: string): Promise<string> { return withTailscaleMutation(() => this.startOwned(proxy)); }
  refresh(proxy: string): Promise<string> { return withTailscaleMutation(() => this.startOwned(proxy, true)); }
  private async startOwned(proxy: string, refresh = false): Promise<string> {
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(proxy)) throw new Error('Remote listener must be loopback-only.');
    const { node, config, status } = await this.inspect();
    // Prerequisites are read-only. Private Serve never requires Funnel approval.
    tailscalePrerequisites(status, false);
    const dns = String(node.DNSName ?? '').replace(/\.$/, '');
    if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+\.ts\.net$/.test(dns) || typeof node.ID !== 'string') throw new Error('Tailscale did not report a valid private hostname.');
    const previous = await this.deps.read();
    if (previous && (previous.version !== 1 || previous.nodeId !== node.ID || !previous.host.startsWith(`${dns}:`) ||
        !Number.isInteger(portOf(previous.host)) || portOf(previous.host) < 1024 || portOf(previous.host) > 65535 || !/^http:\/\/127\.0\.0\.1:\d+$/.test(previous.proxy)))
      throw new Error('The saved remote route belongs to another Tailscale node.');
    // Preserve the installation's address even when lower ports become free.
    // A replaced route belongs to its current owner; never move a bookmark silently.
    let port: number | undefined;
    if (refresh) {
      if (!previous) throw new Error('No saved remote link needs refreshing.');
      let conflict = false;
      try { safe(config, previous, true); } catch (cause) { if (!(cause instanceof RemoteRouteConflict)) throw cause; conflict = true; }
      if (!conflict) throw new Error('The remote route is available again. Use Refresh to reconnect with the existing link.');
      // Explicit recovery may select a free port, but never removes the replaced route.
    } else if (previous) { safe(config, previous, true); port = portOf(previous.host); }
    port ??= freePort(config);
    const next: Custody = { version: 1, nodeId: node.ID, host: `${dns}:${port}`, proxy };
    safe(config, previous?.host === next.host ? previous : next, true);
    // Save custody before a mutation so a crash cannot silently claim a different route on restart.
    await this.deps.write(next);
    try {
      await this.deps.run(['serve', '--bg', '--yes', `--https=${port}`, proxy]);
      const after = await this.inspect(); safe(after.config, next, false);
      if (after.node.ID !== next.nodeId || !isDeepStrictEqual(unrelated(config, next.host), unrelated(after.config, next.host)))
        throw new Error('Tailscale route custody changed. Remote admission is disabled.');
    } catch (error) {
      // A command may already have changed native state. Never classify its
      // verification failure as a read-only prerequisite retry.
      throw new Error(error instanceof Error ? error.message : 'Remote Serve could not be verified.');
    }
    this.custody = next; return `https://${next.host}`;
  }
  async verify(): Promise<void> {
    const custody = this.custody; if (!custody) throw new Error('Remote Serve is not ready.');
    const { node, config } = await this.inspect();
    if (node.ID !== custody.nodeId || String(node.DNSName ?? '').replace(/\.$/, '') + `:${portOf(custody.host)}` !== custody.host) throw new Error('Tailscale node changed.');
    safe(config, custody, false);
  }
  stop(): Promise<void> { return withTailscaleMutation(() => this.stopOwned()); }
  private async stopOwned(): Promise<void> {
    const custody = this.custody ?? await this.deps.read(); if (!custody) return;
    const { node, config } = await this.inspect();
    if (node.ID !== custody.nodeId) throw new Error('Remote route custody changed; no route was removed.');
    safe(config, custody, true);
    if (!Object.keys(object(object(config.TCP)[String(portOf(custody.host))])).length && !Object.keys(routes(config, custody.host)).length) {
      this.custody = null; return;
    }
    await this.deps.run(['serve', `--https=${portOf(custody.host)}`, 'off']);
    const after = await this.inspect();
    if (after.node.ID !== custody.nodeId || Object.keys(routes(after.config, custody.host)).length ||
      !isDeepStrictEqual(unrelated(config, custody.host), unrelated(after.config, custody.host))) throw new Error('Remote route removal could not be verified.');
    // Retain the empty route receipt so re-enabling/restarting uses this same port.
    this.custody = null;
  }
}
