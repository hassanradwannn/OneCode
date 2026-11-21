import { randomBytes } from 'node:crypto';
import { RELAY_HEALTH } from '../../shared/relay-protocol.js';
import { RelayChannel } from './relay-channel.js';
import { acquireRelayEnrollment } from './relay-enrollment.js';
import { readPublicJson } from './tailscale-public.js';

export class RelayRemote {
  private channel: RelayChannel | undefined;
  private release: (() => void) | undefined;
  private abort = new AbortController();
  private readonly probe = randomBytes(32).toString('base64url');

  async start(proxy: string): Promise<string> {
    const target = new URL(proxy);
    if (target.origin !== proxy || target.hostname !== '127.0.0.1' || target.protocol !== 'http:' || !target.port) {
      throw new Error('Remote must use its current loopback listener.');
    }
    const { credential, release } = await acquireRelayEnrollment();
    this.release = release;
    this.channel = new RelayChannel(credential, 'remote', Number(target.port));
    return this.channel.origin.origin;
  }

  matchesProbe(value: string | string[] | undefined): boolean { return value === this.probe; }

  async verify(): Promise<void> {
    const channel = this.channel;
    if (!channel?.online) throw new Error(channel?.detail ?? 'OneCode Relay is unavailable.');
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(5_000)]);
    try {
      const result = await readPublicJson(new URL(RELAY_HEALTH, channel.origin), {
        signal, accept: 'application/json', headers: { 'x-onecode-relay-check': this.probe }
      });
      if (result.status === 200 && (result.json as { ready?: boolean } | null)?.ready === true && channel.online) return;
    } catch { /* only report the fixed error below */ }
    throw new Error('Waiting for public HTTPS on the OneCode relay.');
  }

  async stop(): Promise<void> {
    this.abort.abort();
    try { await this.channel?.stop(); } finally { this.release?.(); }
  }
}
