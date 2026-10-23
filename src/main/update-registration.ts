/** Read-only custody check for the existing per-user NSIS installation. */
import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { BUILD_CHANNEL, type BuildChannel } from '../shared/build-channel.js';

export const ONECODE_INSTALLER_GUID = BUILD_CHANNEL === 'beta' ? '35baded0-d4e2-5fee-872a-11b461352695' : '7b3f238f-62c9-5e7a-a1d5-02806675d41d';
export function windowsInstallerFiles(channel: BuildChannel): { executable: string; uninstaller: string } {
  return channel === 'beta'
    ? { executable: 'onecode-beta.exe', uninstaller: 'Uninstall onecode-beta.exe' }
    : { executable: 'OneCode.exe', uninstaller: 'Uninstall OneCode.exe' };
}
const { uninstaller: UNINSTALLER } = windowsInstallerFiles(BUILD_CHANNEL);
type Registration = { location: string | null; uninstall: string | null };
const same = (a: string, b: string) => path.win32.normalize(a).replace(/[\\/]+$/, '').toLowerCase() === path.win32.normalize(b).replace(/[\\/]+$/, '').toLowerCase();

export function registeredInstallTarget(executable: string, rows: Registration[]): string | null {
  return registeredInstallTargetForChannel(executable, rows, BUILD_CHANNEL);
}

export function registeredInstallTargetForChannel(executable: string, rows: Registration[], channel: BuildChannel): string | null {
  const { executable: exe, uninstaller } = windowsInstallerFiles(channel);
  const target = path.win32.dirname(executable);
  if (path.win32.basename(executable).toLowerCase() !== exe.toLowerCase() || !path.win32.isAbsolute(target)) return null;
  const active = rows.filter(row => row.location !== null || row.uninstall !== null);
  if (!active.length || active.some(row => !row.location || !same(row.location, target) ||
      row.uninstall !== `"${path.win32.join(target, uninstaller)}" /currentuser`)) return null;
  return target;
}

function query(key: string, value: string, view: string): Promise<string | null> {
  const reg = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
  return new Promise(resolve => execFile(reg, ['query', key, '/v', value, `/reg:${view}`],
    { windowsHide: true, timeout: 5000, maxBuffer: 16384 }, (error, stdout) => {
      if (error) { resolve(null); return; }
      const row = stdout.split(/\r?\n/).find(line => line.trimStart().startsWith(`${value} `));
      resolve(row?.match(/\sREG_SZ\s+(.+)$/)?.[1]?.trim() ?? null);
    }));
}

/** Never redirects an unpacked/foreign build to the registered installation. */
export async function currentWindowsInstallTarget(executable = process.execPath): Promise<string | null> {
  if (process.platform !== 'win32') return null;
  const rows = await Promise.all(['64', '32'].map(async view => {
    const [location, uninstall] = await Promise.all([
      query(`HKCU\\Software\\${ONECODE_INSTALLER_GUID}`, 'InstallLocation', view),
      query(`HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${ONECODE_INSTALLER_GUID}`, 'UninstallString', view)
    ]);
    return { location, uninstall };
  }));
  const target = registeredInstallTarget(executable, rows);
  if (!target) return null;
  try {
    // Reject path redirection at every ancestor, including a directory junction.
    for (let node = target; ; node = path.dirname(node)) {
      if ((await lstat(node)).isSymbolicLink()) return null;
      const parent = path.dirname(node); if (parent === node) break;
    }
    if (!same(await realpath(executable), executable) || !(await lstat(path.join(target, UNINSTALLER))).isFile()) return null;
    return target;
  } catch { return null; }
}
