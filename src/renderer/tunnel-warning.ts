import { providerText } from './provider-text.js';
import { ui } from './i18n.js';
import { connectorsSharingTunnel, type ConnectorTunnelIds } from '../shared/tunnel-ids.js';
import type { SurfaceId } from '../shared/types.js';

const CONNECTOR: Record<SurfaceId, string> = { core: 'Core', desktop: 'Desktop', plugins: 'Plugins' };

/**
 * Shows, under a tunnel ID field, which other connectors are set to the same ID (#1340).
 * A warning, not a refusal: the IDs are the user's to choose.
 */
export function paintSharedTunnel(note: HTMLElement, tunnel: ConnectorTunnelIds, surface: SurfaceId): void {
  const others = connectorsSharingTunnel(tunnel, surface);
  note.hidden = others.length === 0;
  const names = others.map(id => CONNECTOR[id]).join(', ');
  ui(note, 'textContent', () => others.length ? providerText(
    "This tunnel ID is also set for {0}. Each plugin needs its own tunnel; otherwise Gemini sends some calls to the wrong plugin and they fail with UNKNOWN_TOOL.",
    [names]
  ) : '');
}
