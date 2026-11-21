import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { parseRelayOrigin, relayDigest } from '../src/shared/relay-protocol.ts';
import { createRelayServer } from './server.ts';

if (process.argv[2] === 'enroll') {
  const key = randomBytes(32).toString('base64url');
  console.log(JSON.stringify({ key, digest: relayDigest(key) }, null, 2));
} else {
  const required = (name) => {
    const value = process.env[name];
    if (!value) throw new Error('Missing ' + name);
    return value;
  };
  const origin = parseRelayOrigin(required('ONECODE_RELAY_ORIGIN'));
  const port = Number(process.env.ONECODE_RELAY_LISTEN_PORT ?? (origin.port || '443'));
  const [registry, key, cert] = await Promise.all([
    readFile(required('ONECODE_RELAY_ENROLLMENTS'), 'utf8'),
    readFile(required('ONECODE_RELAY_TLS_KEY')),
    readFile(required('ONECODE_RELAY_TLS_CERT'))
  ]);
  const digests = JSON.parse(registry);
  if (!Array.isArray(digests) || !digests.every(digest => typeof digest === 'string')) throw new Error('Expected a JSON array of enrollment digests.');
  const relay = createRelayServer({ origin: origin.origin, digests, tls: { key, cert } });
  relay.server.listen(port, process.env.ONECODE_RELAY_LISTEN_HOST ?? '0.0.0.0', () => console.log('OneCode relay is listening.'));
  for (const name of ['SIGTERM', 'SIGINT']) process.once(name, () => { void relay.stop(); });
}
