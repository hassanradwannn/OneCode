/** Recovery copy is shared by desktop setup and Remote settings. */
export type RecoveryStep = { text: string; command?: string; url?: string };
export const firewallCommand = [
  "$svc = Get-CimInstance Win32_Service -Filter \"Name='Tailscale'\" -ErrorAction Stop",
  "if (-not $svc) { throw 'Install Tailscale first.' }",
  "$match = [regex]::Match($svc.PathName, '^\"([^\"]+)\"|^(\\S+)')",
  "$exe = if ($match.Groups[1].Success) { $match.Groups[1].Value } else { $match.Groups[2].Value }",
  "if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'Tailscale service executable was not found.' }",
  "if (-not (Get-NetFirewallRule -Name 'OneCode-Tailscale-UDP' -ErrorAction SilentlyContinue)) { New-NetFirewallRule -Name 'OneCode-Tailscale-UDP' -DisplayName 'Tailscale direct tunnel (OneCode)' -Direction Inbound -Action Allow -Protocol UDP -LocalPort 41641 -Program $exe -Profile Any }"
].join('\n');

export function recoverySteps(step: string | undefined, mode: 'remote' | 'tunnel'): RecoveryStep[] {
  const steps: RecoveryStep[] = [];
  if (step === 'install') steps.push({ text: 'Install Tailscale, then open it. OneCode checks again automatically; no PATH or terminal setup is needed.', url: 'https://tailscale.com/download' });
  if (step === 'login' || step === 'install') steps.push({ text: 'In the Tailscale tray menu, sign in and connect this computer to your account. Leave Tailscale running.' });
  if (step === 'operator') steps.push(
    { text: 'On Linux, Tailscale must authorize your desktop user before OneCode can publish its own Serve/Funnel paths. Approve the system authorization prompt from Connect. If you dismissed it, run this once in a terminal and then retry Connect.', command: 'sudo tailscale set --operator="$USER"' });
  if (step === 'dns') steps.push(
    { text: 'Open the DNS page of your Tailscale admin console.', url: 'https://login.tailscale.com/admin/dns' },
    { text: 'Turn on MagicDNS. Under HTTPS Certificates, select Enable HTTPS and approve the certificate notice. A tailnet administrator may need to do this.' });
  if (step === 'funnel') steps.push({ text: 'Open Access controls in the Tailscale admin console. Expand Funnel and select Add Funnel to policy. An Owner, Admin or Network admin must approve this.', url: 'https://login.tailscale.com/admin/acls' });
  if (!step) steps.push(
    { text: 'Confirm Tailscale is connected, then inspect its status in PowerShell. If tailscale is not on PATH, use its full executable path from OneCode Advanced settings.', command: 'tailscale status\ntailscale serve status\ntailscale netcheck' },
    { text: 'On Windows, if the Tailscale service is stopped, open PowerShell as Administrator and start it.', command: 'Start-Service -Name Tailscale' });
  steps.push({ text: step ? 'Return to OneCode. It resumes setup automatically after the prerequisite is ready.' : 'Return to OneCode and retry setup. It checks the current routes before changing anything.' });
  if (mode === 'remote') steps.push({ text: 'On the other device, connect Tailscale to the same account, then open the copied Remote link. Tailnet access policy must allow the connection.' });
  steps.push(
    { text: 'If a firewall blocks Tailscale, allow outbound TCP 443 and UDP 3478 for the Tailscale service. Opening a local OneCode HTTP port is unnecessary; its listener stays on loopback.', url: 'https://tailscale.com/docs/reference/faq/firewall-ports' },
    { text: 'Optional Windows firewall repair for direct peer connections: run this in PowerShell as Administrator. It allows only the installed Tailscale service on UDP 41641; substitute your configured UDP port if you changed the default. Tailscale normally works through its relay without this rule.', command: firewallCommand });
  return steps;
}
