import https from 'node:https';
import { createConnection } from 'node:net';
import type { Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import {
  RELAY_CHANNEL, RELAY_KEY, RELAY_STREAM, RELAY_UPGRADE, relayDigest, relayPublicOrigin
} from '../../shared/relay-protocol.js';
import type { RelaySurface } from '../../shared/relay-protocol.js';

export type RelayCredential = { origin: URL; key: string };
const CHANNEL_IDLE = 25_000;
const MAX_STREAMS = 32;

/** The host initiates every TLS connection. The only destination is its own fixed loopback listener. */
export class RelayChannel {
  readonly origin: URL;
  private abort = new AbortController();
  private streams = new Map<string, () => void>();
  private run: Promise<void>;
  private connected = false;
  private rejected = false;

  constructor(
    private credential: RelayCredential,
    surface: RelaySurface, private targetPort: number,
    private request: typeof https.request = https.request
  ) {
    if (!RELAY_KEY.test(credential.key) || !Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) throw new Error('Invalid OneCode relay configuration.');
    const digest = relayDigest(credential.key);
    this.origin = relayPublicOrigin(credential.origin, digest, surface);
    this.run = this.reconnect(RELAY_CHANNEL + surface + '/' + digest.slice(0, 24));
  }

  get online(): boolean { return this.connected; }
  get detail(): string { return this.rejected ? 'The relay declined this device’s enrollment.' : 'Waiting for the OneCode relay.'; }
  async stop(): Promise<void> { this.abort.abort(); await this.run; }

  private async reconnect(path: string): Promise<void> {
    let wait = 1_000;
    const { signal } = this.abort;
    while (!signal.aborted) {
      const started = Date.now();
      try { await this.listen(path, signal); }
      catch { /* retry a transport connection without resending an HTTP request */ }
      finally {
        this.connected = false;
        for (const cancel of this.streams.values()) cancel();
      }
      if (signal.aborted) return;
      if (Date.now() - started > CHANNEL_IDLE) wait = 1_000;
      try { await delay(wait, undefined, { signal }); } catch { return; }
      wait = Math.min(wait * 2, 15_000);
    }
  }

  private async listen(path: string, signal: AbortSignal): Promise<void> {
    const response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
      const request = this.request(new URL(path, this.credential.origin), {
        agent: false, signal, headers: { Authorization: 'Bearer ' + this.credential.key }
      }, resolve);
      request.setTimeout(CHANNEL_IDLE, () => request.destroy());
      request.once('error', reject);
      request.end();
    });
    this.rejected = response.statusCode === 404 || response.statusCode === 401;
    if (response.statusCode !== 200 || response.headers['content-type'] !== 'application/x-ndjson') {
      response.destroy(); return;
    }
    this.connected = true;
    let buffer = '';
    response.setEncoding('utf8');
    for await (const chunk of response) {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line) continue;
        const frame: unknown = line.length <= 64 ? JSON.parse(line) : null;
        const id = frame && typeof frame === 'object' && 'id' in frame ? frame.id : null;
        if (typeof id !== 'string' || !RELAY_KEY.test(id)) { response.destroy(); return; }
        if (!this.streams.has(id) && this.streams.size < MAX_STREAMS) this.openStream(id, signal);
      }
      if (buffer.length > 64) { response.destroy(); return; }
    }
  }

  private openStream(id: string, signal: AbortSignal): void {
    let local: Socket | undefined, stream: Socket | undefined;
    const request = this.request(new URL(RELAY_STREAM + id, this.credential.origin), {
      agent: false, signal, headers: {
        Authorization: 'Bearer ' + this.credential.key, Connection: 'Upgrade', Upgrade: RELAY_UPGRADE
      }
    });
    const cancel = () => {
      if (this.streams.get(id) !== cancel) return;
      this.streams.delete(id);
      request.destroy(); local?.destroy(); stream?.destroy();
    };
    this.streams.set(id, cancel);
    request.setTimeout(8_000, cancel);
    request.once('error', cancel);
    request.once('response', response => { response.destroy(); cancel(); });
    request.once('upgrade', (response, socket, head) => {
      stream = socket;
      if (response.statusCode !== 101 || response.headers.upgrade !== RELAY_UPGRADE || signal.aborted ||
          this.streams.get(id) !== cancel) { socket.destroy(); cancel(); return; }
      socket.setTimeout(0);
      socket.pause();
      if (head.length) socket.unshift(head);
      local = createConnection({ host: '127.0.0.1', port: this.targetPort });
      local.once('error', cancel);
      local.once('close', () => { if (!local?.readableEnded) cancel(); });
      socket.once('error', cancel); socket.once('close', cancel);
      socket.pipe(local).pipe(socket);
    });
    request.end();
  }
}
