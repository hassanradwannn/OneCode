import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { childEnv } from '../exec.js';

const run = promisify(execFile);
// Only the explicit desktop repair action may launch administrator consent.
export const TAILSCALE_RESTART_SCRIPT = `
$ErrorActionPreference='Stop'
try {
  $service=Get-CimInstance Win32_Service -Filter "Name='Tailscale'"
  if (-not $service) { throw 'Tailscale is not installed.' }
  Restart-Service -Name Tailscale -ErrorAction Stop
  (Get-Service -Name Tailscale).WaitForStatus([System.ServiceProcess.ServiceControllerStatus]::Running,[TimeSpan]::FromSeconds(30))
  exit 0
} catch { exit 1 }
`;

export function tailscaleRepairCommand(windows: string): { file: string; args: string[] } {
  const file = path.win32.join(windows, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const encoded = Buffer.from(TAILSCALE_RESTART_SCRIPT, 'utf16le').toString('base64');
  const launch = `$ErrorActionPreference='Stop'; try { $p=Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -Verb RunAs -WindowStyle Hidden -ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand','${encoded}') -Wait -PassThru; exit $p.ExitCode } catch { exit 1 }`;
  return { file, args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(launch, 'utf16le').toString('base64')] };
}

let pending: Promise<void> | null = null;
export function restartWindowsTailscale(): Promise<void> {
  if (pending) return pending;
  if (process.platform !== 'win32' || !process.env.SystemRoot) return Promise.reject(new Error('Restart Tailscale through its system service, then return to OneCode.'));
  const { file, args } = tailscaleRepairCommand(process.env.SystemRoot);
  pending = run(file, args, { windowsHide: true, timeout: 180_000, maxBuffer: 64 * 1024, env: childEnv() })
    .then(() => undefined, () => { throw new Error('Tailscale restart was cancelled or could not be confirmed. Check Tailscale before trying Repair public connection again.'); })
    .finally(() => { pending = null; });
  return pending;
}
