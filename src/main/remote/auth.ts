import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { RemoteDevice } from '../../shared/remote.js';

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();
/** Remote-only link authority; never a model, bridge, or provider credential. */
export class RemoteAuth {
  private linkHash: Buffer | null = null;
  private devices = new Map<string, RemoteDevice & { hash: Buffer }>();
  private attempts: number[] = [];
  constructor(private now: () => number = Date.now) {}
  activate(key: string): void {
    this.clear(); this.linkHash = digest(key);
  }
  connect(key: string, name: string): { token: string; device: RemoteDevice } {
    const now = this.now(); this.attempts = this.attempts.filter(at => now - at < 60_000);
    if (this.attempts.length >= 10) throw new Error('Too many connection attempts. Wait one minute.');
    this.attempts.push(now);
    if (!this.linkHash || !/^[A-Za-z0-9_-]{43}$/.test(key) || !timingSafeEqual(digest(key), this.linkHash)) throw new Error('This remote link is no longer valid. Copy the current link from OneCode Settings → Remote.');
    if (this.list().length >= 16) throw new Error('Remove a connected browser in OneCode Settings → Remote before adding another.');
    const token = randomBytes(32).toString('base64url');
    const device = { id: randomUUID(), name: name.trim().slice(0, 80) || 'Remote browser', expiresAt: now + 8 * 60 * 60_000, lastSeenAt: now };
    this.devices.set(device.id, { ...device, hash: digest(token) }); return { token, device };
  }
  authenticate(token: string): RemoteDevice | null {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const hash = digest(token), now = this.now();
    for (const [id, device] of this.devices) {
      if (device.expiresAt <= now) { this.devices.delete(id); continue; }
      if (timingSafeEqual(device.hash, hash)) { device.lastSeenAt = now; const { hash: _hash, ...view } = device; return view; }
    }
    return null;
  }
  list(): RemoteDevice[] {
    const now = this.now();
    for (const [id, device] of this.devices) if (device.expiresAt <= now) this.devices.delete(id);
    return [...this.devices.values()].map(({ hash: _hash, ...device }) => ({ ...device }));
  }
  revoke(id: string): void { this.devices.delete(id); }
  clear(): void { this.devices.clear(); this.linkHash = null; this.attempts = []; }
}
