import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readDurable, writeDurableNow } from '../durable.js';
import { authorityInstallationId } from '../secrets.js';
import type { RemoteDevice } from '../../shared/remote.js';

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();
const HASH = /^[a-f0-9]{64}$/;
const MAX_DEVICES = 16;
interface DeviceGrant { id: string; name: string; tokenHash: string; linkHash: string; issuedAt: number; lastSeenAt: number }
interface RemoteLedger { version: 2; installationId: string; linkHash: string | null; devices: DeviceGrant[] }
function validDevice(value: unknown): value is DeviceGrant {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as DeviceGrant;
  return typeof row.id === 'string' && /^[a-f0-9-]{36}$/.test(row.id) &&
    typeof row.name === 'string' && row.name.length <= 80 &&
    typeof row.tokenHash === 'string' && HASH.test(row.tokenHash) &&
    typeof row.linkHash === 'string' && HASH.test(row.linkHash) &&
    Number.isSafeInteger(row.issuedAt) && row.issuedAt > 0 &&
    Number.isSafeInteger(row.lastSeenAt) && row.lastSeenAt >= row.issuedAt;
}

/** Remote link authority and durable browser grants; bearer values are never persisted. */
export class RemoteAuth {
  private linkHash: Buffer | null = null;
  private ledgerLinkHash: string | null = null;
  private devices = new Map<string, DeviceGrant>();
  private installationId = '';
  private pendingRevocations = new Set<string>();
  private attempts: number[] = [];
  private ready = false;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private now: () => number = Date.now) {}

  private serialized<T>(body: () => Promise<T>): Promise<T> {
    const work = this.tail.catch(() => undefined).then(body);
    this.tail = work.then(() => undefined, () => undefined);
    return work;
  }

  async initialize(): Promise<void> {
    await this.serialized(async () => {
      this.ready = false;
      this.devices.clear();
      this.installationId = await authorityInstallationId();
      let value: unknown;
      try { value = await readDurable<unknown>('remote-authority', { strict: true }); }
      catch { throw new Error('Remote authorization state is unavailable or corrupt'); }
      if (value === null) { this.ledgerLinkHash = null; this.ready = true; return; }
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Remote authorization state is corrupt');
      const ledger = value as RemoteLedger;
      if (ledger.version !== 2 || ledger.installationId !== this.installationId || !(ledger.linkHash === null || (typeof ledger.linkHash === 'string' && HASH.test(ledger.linkHash))) ||
          !Array.isArray(ledger.devices) || ledger.devices.length > MAX_DEVICES || !ledger.devices.every(validDevice))
        throw new Error('Remote authorization state is corrupt');
      if (new Set(ledger.devices.map(row => row.id)).size !== ledger.devices.length ||
          new Set(ledger.devices.map(row => row.tokenHash)).size !== ledger.devices.length ||
          ledger.devices.some(row => row.linkHash !== ledger.linkHash)) throw new Error('Remote authorization state is corrupt');
      this.ledgerLinkHash = ledger.linkHash;
      this.devices = new Map(ledger.devices.map(row => [row.id, row]));
      this.ready = true;
    });
  }

  private async commit(linkHash: string | null, devices: Map<string, DeviceGrant>): Promise<void> {
    if (!this.ready) throw new Error('Remote authorization state is unavailable');
    const next: RemoteLedger = { version: 2, installationId: this.installationId, linkHash, devices: [...devices.values()] };
    await writeDurableNow('remote-authority', next);
    this.ledgerLinkHash = linkHash;
    this.devices = devices;
  }

  /** Startup reactivates the saved link and preserves browser digests for that same link. */
  async activate(key: string): Promise<void> {
    if (!this.ready) await this.initialize();
    const nextHash = digest(key).toString('hex');
    await this.serialized(async () => {
      if (this.ledgerLinkHash !== nextHash) await this.commit(nextHash, new Map());
      this.linkHash = Buffer.from(nextHash, 'hex');
      this.pendingRevocations.clear();
    });
  }

  async connect(key: string, name: string): Promise<{ token: string; device: RemoteDevice }> {
    if (!this.ready) await this.initialize();
    return this.serialized(async () => {
      const now = this.now(); this.attempts = this.attempts.filter(at => now - at < 60_000);
      if (this.attempts.length >= 10) throw new Error('Too many connection attempts. Wait one minute.');
      this.attempts.push(now);
      if (!this.linkHash || !/^[A-Za-z0-9_-]{43}$/.test(key) || !timingSafeEqual(digest(key), this.linkHash)) throw new Error('This remote link is no longer valid. Copy the current link from OneCode Settings → Remote.');
      if (this.devices.size >= MAX_DEVICES) throw new Error('Remove a connected browser in OneCode Settings → Remote before adding another.');
      const token = randomBytes(32).toString('base64url');
      const row: DeviceGrant = { id: randomUUID(), name: name.trim().slice(0, 80) || 'Remote browser', tokenHash: digest(token).toString('hex'),
        linkHash: this.ledgerLinkHash!, issuedAt: now, lastSeenAt: now };
      const next = new Map(this.devices); next.set(row.id, row);
      await this.commit(this.ledgerLinkHash, next);
      return { token, device: this.view(row) };
    });
  }

  authenticate(token: string): RemoteDevice | null {
    if (!this.ready || !this.linkHash || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const tokenHash = digest(token);
    for (const row of this.devices.values()) {
      if (this.pendingRevocations.has(row.id) || row.linkHash !== this.ledgerLinkHash) continue;
      if (timingSafeEqual(Buffer.from(row.tokenHash, 'hex'), tokenHash)) {
        row.lastSeenAt = Math.max(row.lastSeenAt, this.now());
        return this.view(row);
      }
    }
    return null;
  }

  list(): RemoteDevice[] {
    if (!this.ready) return [];
    return [...this.devices.values()].filter(row => !this.pendingRevocations.has(row.id)).map(row => this.view(row));
  }

  private view(row: DeviceGrant): RemoteDevice { return { id: row.id, name: row.name, lastSeenAt: row.lastSeenAt }; }

  async revoke(id: string): Promise<void> {
    if (!this.ready) throw new Error('Remote authorization state is unavailable');
    this.pendingRevocations.add(id);
    await this.serialized(async () => {
      const next = new Map(this.devices); next.delete(id);
      await this.commit(this.ledgerLinkHash, next);
      this.pendingRevocations.delete(id);
    });
  }

  /** Explicit Remote disable or a deliberately rotated link revokes all browser grants. */
  async clear(): Promise<void> {
    if (!this.ready) await this.initialize();
    for (const id of this.devices.keys()) this.pendingRevocations.add(id);
    await this.serialized(async () => {
      await this.commit(null, new Map());
      this.linkHash = null;
      this.pendingRevocations.clear();
      this.attempts = [];
    });
  }
}
