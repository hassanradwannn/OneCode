/** Read-only Windows installation discovery; never executes a registered command line. */
import path from 'node:path';
import os from 'node:os';
import { runPowerShell } from './exec.js';
import type { ChatBrowser } from '../shared/types.js';

type Browser = Exclude<ChatBrowser, 'cos'>;
export const WINDOWS_BROWSER_NAMES: Record<Browser, readonly string[]> = {
  chrome: ['chrome.exe', 'chromium.exe'], edge: ['msedge.exe'], brave: ['brave.exe'], firefox: ['firefox.exe']
};

/** Discard registration arguments and require an absolute executable of the selected family. */
export function windowsBrowserExecutable(value: unknown, browser: Browser, env: NodeJS.ProcessEnv = process.env): string | null {
  if (typeof value !== 'string' || value.length > 8192 || /[\x00-\x1f]/.test(value)) return null;
  const expanded = value.trim().replace(/%([^%]+)%/g, (original, name: string) => {
    const key = Object.keys(env).find(key => key.toLowerCase() === name.toLowerCase());
    return key ? env[key] ?? original : original;
  });
  const match = /^(?:"([^"\r\n]+\.exe)"|([^"\r\n]+?\.exe))(?:\s.*)?$/i.exec(expanded);
  const executable = match?.[1] ?? match?.[2];
  if (!executable || executable.includes('%') || !path.win32.isAbsolute(executable) ||
      !WINDOWS_BROWSER_NAMES[browser].includes(path.win32.basename(executable).toLowerCase())) return null;
  return path.win32.normalize(executable);
}

export async function registeredWindowsBrowsers(browser: Browser, env = process.env,
  powershell: typeof runPowerShell = runPowerShell): Promise<string[]> {
  // All interpolated names come from the closed browser enum, never registry or user text.
  const names = WINDOWS_BROWSER_NAMES[browser].map(name => `'${name}'`).join(',');
  const script = `$ErrorActionPreference='Stop'; $found=[System.Collections.Generic.List[string]]::new();
$names=@(${names});
foreach($root in @('HKCU:\\Software','HKLM:\\Software','HKCU:\\Software\\WOW6432Node','HKLM:\\Software\\WOW6432Node')) {
  foreach($name in $names) {
    try { $key=Get-Item -LiteralPath ($root+'\\Microsoft\\Windows\\CurrentVersion\\App Paths\\'+$name) -ErrorAction Stop; $value=$key.GetValue(''); if($value -is [string]) { $found.Add($value) } } catch {}
  }
  try {
    foreach($client in @(Get-ChildItem -LiteralPath ($root+'\\Clients\\StartMenuInternet') -ErrorAction Stop | Select-Object -First 128)) {
      try { $key=Get-Item -LiteralPath ($client.PSPath+'\\shell\\open\\command') -ErrorAction Stop; $value=$key.GetValue(''); if($value -is [string]) { $found.Add($value) } } catch {}
    }
  } catch {}
}
foreach($name in $names) {
  foreach($process in @(Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($name)) -ErrorAction SilentlyContinue)) {
    try { if($process.Path) { $found.Add($process.Path) } } catch {}
  }
}
ConvertTo-Json -InputObject @($found | Select-Object -Unique -First 256) -Compress`;
  try {
    const result = await powershell(script, os.tmpdir(), 5000);
    if (result.exitCode !== 0 || result.timedOut || result.truncated || result.stdout.length > 128_000) return [];
    const rows: unknown = JSON.parse(result.stdout);
    if (!Array.isArray(rows)) return [];
    return [...new Set(rows.flatMap(row => { const exe = windowsBrowserExecutable(row, browser, env); return exe ? [exe] : []; }))];
  } catch { return []; }
}
