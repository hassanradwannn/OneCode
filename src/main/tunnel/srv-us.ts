import { createHash, timingSafeEqual } from 'node:crypto';
import { createConnection } from 'node:net';
import type { Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { Client, utils } from 'ssh2';
import type { RelaySurface } from '../../shared/relay-protocol.js';
import { getSecret, setSecret } from '../secrets.js';

const SERVICE = 'srv.us';
// Observed on Windows and native Ubuntu. Require an updated pin if the service rotates this key.
const HOST_KEY = Buffer.from('oG4TmU4TFvLkEOWN80+x+ITOMfFRyusJ1IC7ZBYAKTM', 'base64');
const PORTS = { mcp: 1, remote: 2 };
const SLOTS = { mcp: 'srvUsMcpKey', remote: 'srvUsRemoteKey' } as const;
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const MAX_CONNECTIONS = 32;
const identities = new Map<RelaySurface, Promise<string>>();

export function srvUsMcpEnrolled(): Promise<string | null> { return getSecret(SLOTS.mcp); }

export function srvUsPrivateKey(surface: RelaySurface): Promise<string> {
  const existing = identities.get(surface);
  if (existing) return existing;
  const pending = (async () => {
    const key = await getSecret(SLOTS[surface]);
    if (key) return key;
    const generated = utils.generateKeyPairSync('ed25519', { comment: 'OneCode ' + surface }).private;
    await setSecret(SLOTS[surface], generated);
    return generated;
  })();
  identities.set(surface, pending);
  void pending.finally(() => { if (identities.get(surface) === pending) identities.delete(surface); }).catch(() => undefined);
  return pending;
}

/** The provider assigns an unaliased hostname from the SSH wire public key and forwarding port. */
export function srvUsOrigin(privateKey: string, surface: RelaySurface): URL {
  const key = utils.parseKey(privateKey);
  if (key instanceof Error || Array.isArray(key) || key.type !== 'ssh-ed25519' || !key.isPrivateKey()) {
    throw new Error('The saved srv.us device key is invalid.');
  }
  // Upstream endpointURLs in backend/main.go.
  const digest = createHash('sha256').update(key.getPublicSSH()).update('\0').update(String(PORTS[surface])).digest().subarray(0, 16);
  let name = '';
  for (let offset = 0; offset < digest.length * 8; offset += 5) {
    const byte = offset >>> 3;
    const pair = (digest[byte]! << 8) | (digest[byte + 1] ?? 0);
    name += BASE32[(pair >>> (11 - (offset & 7))) & 31];
  }
  return new URL('https://' + name + '.' + SERVICE);
}

/** Only one forwarded address is accepted. SSH channels cannot select local services. */
export class SrvUsChannel {
  readonly origin: URL;
  private readonly abort = new AbortController();
  private readonly run: Promise<void>;
  private connected = false;
  private identityRefused = false;

  constructor(private readonly privateKey: string, private readonly surface: RelaySurface, private readonly targetPort: number) {
    if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) throw new Error('srv.us requires a valid OneCode loopback port.');
    this.origin = srvUsOrigin(privateKey, surface);
    this.run = this.reconnect();
  }

  get online(): boolean { return this.connected; }
  get detail(): string {
    return this.identityRefused ? 'The srv.us server identity changed. An updated OneCode release is required.'
      : 'Connecting to srv.us over SSH on port 22…';
  }

  async stop(): Promise<void> { this.abort.abort(); await this.run; }

  private async reconnect(): Promise<void> {
    const { signal } = this.abort;
    let wait = 1_000;
    while (!signal.aborted) {
      const started = Date.now();
      await this.attempt(signal);
      if (signal.aborted) return;
      if (Date.now() - started > 30_000) wait = 1_000;
      try { await delay(wait, undefined, { signal }); } catch { return; }
      wait = Math.min(wait * 2, 20_000);
    }
  }

  private attempt(signal: AbortSignal): Promise<void> {
    return new Promise(resolve => {
      const client = new Client();
      const localSockets = new Set<Socket>();
      const bindHost = '127.0.0.1';
      const bindPort = PORTS[this.surface];
      const timer = setTimeout(() => client.destroy(), 18_000);
      const stop = () => client.destroy();
      signal.addEventListener('abort', stop, { once: true });
      client.once('close', () => {
        this.connected = false;
        clearTimeout(timer);
        signal.removeEventListener('abort', stop);
        for (const local of localSockets) local.destroy();
        resolve();
      });
      client.on('error', stop);
      client.once('ready', () => {
        if (signal.aborted) { stop(); return; }
        // srv.us keeps each forward in a session and broadcasts its address on that channel.
        client.shell(false, (error, session) => {
          if (error || signal.aborted) { stop(); return; }
          session.on('error', stop);
          session.once('close', stop);
          session.resume();
          session.stderr.resume();
          client.forwardIn(bindHost, bindPort, failure => {
            if (failure || signal.aborted) { stop(); return; }
            clearTimeout(timer);
            this.connected = true;
          });
        });
      });
      client.on('tcp connection', (info, accept, reject) => {
        if (!this.connected || signal.aborted || info.destIP !== bindHost || info.destPort !== bindPort ||
            localSockets.size >= MAX_CONNECTIONS) { reject(); return; }
        const stream = accept();
        const local = createConnection({ host: bindHost, port: this.targetPort });
        localSockets.add(local);
        local.once('close', () => { localSockets.delete(local); if (!local.readableEnded) stream.destroy(); });
        local.once('error', () => stream.destroy());
        stream.once('error', () => local.destroy());
        stream.once('close', () => local.destroy());
        stream.pipe(local).pipe(stream);
      });
      try {
        client.connect({
          host: SERVICE, port: 22, username: 'nomatch', privateKey: this.privateKey,
          keepaliveInterval: 10_000, keepaliveCountMax: 3, readyTimeout: 12_000,
          algorithms: { serverHostKey: ['ssh-ed25519'] },
          hostVerifier: (key: Buffer) => {
            const digest = createHash('sha256').update(key).digest();
            this.identityRefused = !timingSafeEqual(digest, HOST_KEY);
            return !this.identityRefused;
          }
        });
      } catch {
        clearTimeout(timer);
        signal.removeEventListener('abort', stop);
        client.destroy();
        resolve();
      }
    });
  }
}
