import { createHash } from 'node:crypto';

export const RELAY_KEY = /^[A-Za-z0-9_-]{43}$/;
export const RELAY_DIGEST = /^[a-f0-9]{64}$/;
export const RELAY_HEALTH = '/.well-known/onecode-remote';
export const RELAY_MCP_METADATA = '/.well-known/oauth-protected-resource';
export const RELAY_MCP_PATH = /^\/mcp\/(?:core|desktop|plugins)\/[A-Za-z0-9_-]{43}$/;
export const RELAY_CHANNEL = '/_onecode/v1/channel/';
export const RELAY_STREAM = '/_onecode/v1/stream/';
export const RELAY_UPGRADE = 'onecode-stream-v1';
export type RelaySurface = 'mcp' | 'remote';

export function relayDigest(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export function parseRelayOrigin(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/.test(url.hostname) || url.hostname.length > 200) {
    throw new Error('Enter the HTTPS address of your OneCode relay.');
  }
  return url;
}

export function relayPublicOrigin(origin: URL, digest: string, surface: RelaySurface): URL {
  return new URL(`https://${surface}-${digest.slice(0, 24)}.${origin.host}`);
}
