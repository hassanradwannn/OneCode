/** Ports discoverable by the companion extension without additional host permissions. */
import { BUILD_CHANNEL } from './build-channel.js';
export const BROWSER_BRIDGE_PORTS = BUILD_CHANNEL === 'beta'
  ? [48765, 48766, 48767, 48768, 48769] as const
  : [28765, 28766, 28767, 28768, 28769] as const;
/**
 * Where Auto looks when 28765-28769 are all taken (#1314). Windows can reserve whole blocks of
 * ports for Hyper-V, WSL2 or Docker, and one such block covered the primary range, so the bridge
 * could not listen anywhere. Two ranges far apart make it unlikely that every block is reserved.
 * Auto only: the fixed choices in Settings stay the primary range.
 */
export const BROWSER_BRIDGE_FALLBACK_PORTS = BUILD_CHANNEL === 'beta'
  ? [49765, 49766, 49767, 49768, 49769, 59765, 59766, 59767, 59768, 59769] as const
  : [29765, 29766, 29767, 29768, 29769, 39765, 39766, 39767, 39768, 39769] as const;
/** Auto's order, and exactly the list the extension scans (extension/background.js `PORTS`). */
export const BROWSER_BRIDGE_AUTO_PORTS = [...BROWSER_BRIDGE_PORTS, ...BROWSER_BRIDGE_FALLBACK_PORTS] as const;
export type BrowserBridgePort = 'auto' | (typeof BROWSER_BRIDGE_PORTS)[number];
