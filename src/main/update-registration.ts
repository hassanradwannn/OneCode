/** Read-only custody check for the existing per-user NSIS installation. */
import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

export const ONECODE_INSTALLER_GUID = '7b3f238f-62c9-5e7a-a1d5-02806675d41d';
type Registration = { location: string | null; uninstall: string | null };
const same = (a: string, b: string) => path.win32.normalize(a).replace(/[\\/]+$/, '').toLowerCase() === path.win32.normalize(b).replace(/[\\/]+$/, '').toLowerCase();

export function registeredInstallTarget(executable: string, rows: Registration[]): string | null {
  const target = path.win32.dirname(executable);
  if (path.win32.basename(executable).toLowerCase() !== 'onecode.exe' || !path.win32.isAbsolute(target)) return null;
  const active = rows.filter(row => row.location !== null || row.uninstall !== null);
  if (!active.length || active.some(row => !row.location || !same(row.location, target) ||
      row.uninstall !== `"${path.win32.join(target, 'Uninstall OneCode.exe')}" /currentuser`)) return null;
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
    if (!same(await realpath(executable), executable) || !(await lstat(path.join(target, 'Uninstall OneCode.exe'))).isFile()) return null;
    return target;
  } catch { return null; }
}
