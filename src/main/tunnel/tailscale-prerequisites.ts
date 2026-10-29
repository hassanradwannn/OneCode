import { tailscaleSetupAction, type TailscaleSetupAction, type TailscaleSetupStep } from '../../shared/tailscale-setup.js';

/** Only read-only prerequisite failures permit automatic setup resumption. */
export class TailscaleSetupRequired extends Error {
  readonly setup: TailscaleSetupAction;
  constructor(step: TailscaleSetupStep, message: string) { super(message); this.setup = tailscaleSetupAction(step); }
}
const row = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
/** Read-only network/daemon wait; it does not authorize opening account setup. */
export class TailscaleNotReady extends Error {
  constructor(message: string, readonly reason: 'network' | 'approval' = 'network') { super(message); }
}

/** Only failed read-only daemon queries qualify. Never apply this to a route mutation. */
export async function readTailscaleDaemon<T>(read: () => Promise<T>): Promise<T> {
  try { return await read(); }
  catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (!/access denied|permission denied|not permitted|administrator|403/i.test(message) &&
        /failed to connect to (?:local )?tailscale|(?:tailscaled|tailscale service).*(?:not running|unavailable)|could not connect|connection refused|ECONNREFUSED|ECONNRESET|broken pipe|unexpected EOF|timed? ?out|timeout|context deadline exceeded|503.*service unavailable/i.test(message))
      throw new TailscaleNotReady('Waiting for the Tailscale service and network after startup or a network change. OneCode will retry automatically. Open Tailscale if it is stopped; complete any hotspot sign-in first.');
    throw error;
  }
}

export function tailscalePrerequisites(status: Record<string, unknown>, funnel: boolean): { id: string; dnsName: string } {
  const self = row(status.Self), tailnet = row(status.CurrentTailnet);
  if (status.BackendState === 'NeedsMachineAuth')
    throw new TailscaleNotReady('Approve this device in the Tailscale admin console. OneCode will detect approval automatically.', 'approval');
  if (!status.AuthURL && (['NoState', 'Starting', 'Stopped'].includes(String(status.BackendState)) ||
      (status.BackendState === 'Running' && self.Online === false)))
    throw new TailscaleNotReady('Waiting for Tailscale to connect. Keep Tailscale running and connected; OneCode will check again automatically.');
  if (status.BackendState !== 'Running' || status.AuthURL)
    throw new TailscaleSetupRequired('login', 'Tailscale is installed. Sign in and connect this device in Tailscale; OneCode will continue automatically.');
  const dnsName = typeof self.DNSName === 'string' ? self.DNSName.toLowerCase().replace(/\.$/, '') : '';
  if (tailnet.MagicDNSEnabled === false || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+\.ts\.net$/.test(dnsName))
    throw new TailscaleSetupRequired('dns', 'Enable MagicDNS and HTTPS certificates in Tailscale. OneCode will detect the change and finish setup automatically.');
  if (typeof self.ID !== 'string' || !/^[\w-]{1,128}$/.test(self.ID)) throw new Error('Tailscale did not report a valid device identity.');
  const capabilities = new Set([...Object.keys(row(self.CapMap)), ...(Array.isArray(self.Capabilities) ? self.Capabilities : [])]);
  if (!capabilities.has('https')) throw new TailscaleSetupRequired('dns', 'Enable HTTPS certificates in Tailscale. OneCode will continue automatically after approval.');
  if (funnel && !capabilities.has('funnel')) throw new TailscaleSetupRequired('funnel', 'Allow Funnel for this device in Tailscale. OneCode will detect approval and configure its tunnel automatically.');
  return { id: self.ID, dnsName };
}
