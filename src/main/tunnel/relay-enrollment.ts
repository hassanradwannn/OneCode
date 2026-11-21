import { getSecret, setSecret } from '../secrets.js';
import { parseRelayOrigin, RELAY_KEY } from '../../shared/relay-protocol.js';
import type { RelayCredential } from './relay-channel.js';

let inUse = 0;
let tail = Promise.resolve();
function serialized<T>(work: () => Promise<T>): Promise<T> {
  const result = tail.then(work);
  tail = result.then(() => undefined, () => undefined);
  return result;
}

export async function relayConfigured(): Promise<boolean> {
  return Boolean(await getSecret('relayEnrollment'));
}

export function saveRelayEnrollment(origin: string, key: string): Promise<void> {
  return serialized(async () => {
    if (inUse) throw new Error('Disconnect the connector and turn off Remote before replacing the relay enrollment.');
    try { origin = parseRelayOrigin(origin.trim()).origin; }
    catch { throw new Error('Enter the HTTPS address of your OneCode relay.'); }
    key = key.trim();
    if (!RELAY_KEY.test(key)) throw new Error('Enter the enrollment key issued by your relay operator.');
    await setSecret('relayEnrollment', JSON.stringify({ origin, key }));
  });
}

export function acquireRelayEnrollment(): Promise<{ credential: RelayCredential; release(): void }> {
  return serialized(async () => {
    const saved = await getSecret('relayEnrollment');
    if (!saved) throw new Error('Add a relay enrollment in Settings → Remote.');
    let credential: RelayCredential;
    try {
      const { origin, key } = JSON.parse(saved);
      if (typeof key !== 'string' || !RELAY_KEY.test(key)) throw new Error();
      credential = { origin: parseRelayOrigin(origin), key };
    } catch { throw new Error('The saved relay enrollment is invalid.'); }
    inUse++;
    let held = true;
    return { credential, release() { if (held) { held = false; inUse--; } } };
  });
}
