/** Fixed first-party destinations only; never carry account data or CLI output. */
export const TAILSCALE_SETUP_ACTIONS = {
  install: { label: 'Install Tailscale', url: 'https://tailscale.com/download' },
  login: { label: 'Open Tailscale sign-in', url: 'https://login.tailscale.com/' },
  operator: { label: 'Allow OneCode to use Tailscale', url: 'https://tailscale.com/docs/reference/tailscale-cli' },
  dns: { label: 'Enable MagicDNS and HTTPS', url: 'https://login.tailscale.com/admin/dns' },
  funnel: { label: 'Allow Funnel in Tailscale', url: 'https://tailscale.com/docs/features/tailscale-funnel' }
} as const;
export type TailscaleSetupStep = keyof typeof TAILSCALE_SETUP_ACTIONS;
export type TailscaleSetupAction = { step: TailscaleSetupStep; label: string; url: string };
export const tailscaleSetupAction = (step: TailscaleSetupStep): TailscaleSetupAction => ({ step, ...TAILSCALE_SETUP_ACTIONS[step] });
