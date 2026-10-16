import type { AppState } from '../shared/types.js';

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
    version: check?.version ?? '',
    checkedAt: check?.checkedAt ?? null,
    detail: check?.detail ?? '',
    // A successful CLI or permission probe alone never means the MCP server is published.
    publicUrl: next.status.state === 'connected' ? next.status.publicUrl : null,
    secureStorageUnavailable: next.secureStorage?.available === false
  };
}
