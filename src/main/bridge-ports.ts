import { BROWSER_BRIDGE_AUTO_PORTS, type BrowserBridgePort } from '../shared/browser-bridge.js';

/** Explicit isolated launchers can supply ports without inheriting a shell environment. */
export function launchBridgePorts(env = process.env, argv = process.argv): string | undefined {
  if (env.CLF_BRIDGE_PORTS !== undefined) return env.CLF_BRIDGE_PORTS;
  const arg = argv.find(value => value.startsWith('--onecode-bridge-ports='));
  if (arg === undefined) return undefined;
  const raw = arg.slice('--onecode-bridge-ports='.length);
  if (!/^\d+(?:,\d+)*$/.test(raw) || raw.split(',').length > 32 ||
      raw.split(',').some(value => Number(value) < 1 || Number(value) > 65535)) throw new Error('Invalid isolated browser bridge ports');
  return raw;
}

/** Keep the existing environment/test override, including OS-assigned port 0. */
export function bridgePortSelection(choice: BrowserBridgePort = 'auto', raw = launchBridgePorts()): {
  candidates: readonly number[]; overridden: boolean;
} {
  const parsed = (raw ?? '').split(',').map(part => Number.parseInt(part.trim(), 10))
    .filter(value => Number.isInteger(value) && value >= 0 && value <= 65535);
  if (parsed.length) return { candidates: parsed, overridden: true };
  return { candidates: choice === 'auto' ? BROWSER_BRIDGE_AUTO_PORTS : [choice], overridden: false };
}
