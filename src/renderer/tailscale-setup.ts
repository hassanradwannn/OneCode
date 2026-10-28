import type { AppState } from '../shared/types.js';

/** A configured native route alone must never enable provider URL setup. */
export function tailscalePublicReady(next: Pick<AppState, 'config' | 'status'>): boolean {
  const ingress = next.status.tailscale?.publicIngress;
  return next.config.tunnel.kind !== 'tailscale' ||
    (next.status.state === 'connected' && next.status.tailscale?.funnel === 'ready' && !!next.status.publicUrl &&
      (ingress?.state === 'ready' || (typeof ingress?.lastReadyAt === 'number' && ingress.lastReadyAt > 0)));
}

/** Presentation of native connection checks; this does not authorize or start a tunnel. */
export function tailscaleSetupView(next: Pick<AppState, 'config' | 'status' | 'resolvedBinary' | 'secureStorage'>) {
  if (next.config.tunnel.kind !== 'tailscale') return null;
  const check = next.status.tailscale;
  return {
    cli: check?.cli === 'ready' ? 'Verified' : check?.cli === 'missing' ? 'Not installed'
      : check?.cli === 'error' ? 'Check failed' : next.resolvedBinary ? 'Detected; Connect verifies it' : 'Not checked',
    account: check?.account === 'ready' ? 'Signed in' : check?.account === 'signed-out' ? 'Sign in to Tailscale' : 'Not checked',
    funnel: check?.funnel === 'ready' ? 'Verified in last check' : check?.funnel === 'permission-required' ? 'Permission required'
      : check?.funnel === 'error' ? 'Check failed' : 'Not checked',
    publicIngress: check?.publicIngress?.state === 'ready' ? 'Verified through public DNS and HTTPS'
      : check?.publicIngress?.state === 'checking' ? 'Checking public DNS and HTTPS'
      : check?.publicIngress?.state === 'dns-pending' ? 'Waiting for public DNS'
      : check?.publicIngress?.state === 'dns-error' ? 'Public DNS check failed'
      : check?.publicIngress?.state === 'tls-error' ? 'Public TLS connection failed'
      : check?.publicIngress?.state === 'timeout' ? 'Public connection check timed out'
      : check?.publicIngress?.state === 'http-error' ? 'Connector metadata path unavailable'
      : check?.publicIngress?.state === 'metadata-error' ? 'Current connector not verified'
      : check?.publicIngress?.state === 'mcp-error' ? 'Public MCP handshake failed'
      : check?.publicIngress?.state === 'retry-required' ? 'Automatic checks paused; retry Connect' : 'Not checked',
    version: check?.version ?? '',
    checkedAt: check?.checkedAt ?? null,
    detail: check?.detail ?? '',
    // Configured address is diagnostic; copy/setup is gated independently above.
    publicUrl: check?.funnel === 'ready' && !['disconnected', 'disconnecting', 'starting-server'].includes(next.status.state)
      ? next.status.publicUrl : null,
    secureStorageUnavailable: next.secureStorage?.available === false
  };
}
