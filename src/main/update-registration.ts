/** Read-only custody check for the existing per-user NSIS installation. */
import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { BUILD_CHANNEL, type BuildChannel } from '../shared/build-channel.js';
import { logWarn } from './logger.js';

export const ONECODE_INSTALLER_GUID = BUILD_CHANNEL === 'beta' ? '35baded0-d4e2-5fee-872a-11b461352695' : '7b3f238f-62c9-5e7a-a1d5-02806675d41d';
export function windowsInstallerFiles(channel: BuildChannel): { executable: string; uninstaller: string } {
  return channel === 'beta'
    ? { executable: 'onecode-beta.exe', uninstaller: 'Uninstall onecode-beta.exe' }
    : { executable: 'OneCode.exe', uninstaller: 'Uninstall OneCode.exe' };
}
const { uninstaller: UNINSTALLER } = windowsInstallerFiles(BUILD_CHANNEL);
type Registration = { location: string | null; uninstall: string | null };
type RegistrationCheck = { target: string; reason?: never; viewIndex?: never } | { target: null; reason: string; viewIndex?: number };
const same = (a: string, b: string) => path.win32.normalize(a).replace(/[\\/]+$/, '').toLowerCase() === path.win32.normalize(b).replace(/[\\/]+$/, '').toLowerCase();

export function registeredInstallTarget(executable: string, rows: Registration[]): string | null {
  return registeredInstallTargetForChannel(executable, rows, BUILD_CHANNEL);
}

export function registeredInstallTargetForChannel(executable: string, rows: Registration[], channel: BuildChannel): string | null {
  return checkRegistration(executable, rows, channel).target;
}

function checkRegistration(executable: string, rows: Registration[], channel: BuildChannel): RegistrationCheck {
  const { executable: exe, uninstaller } = windowsInstallerFiles(channel);
  const target = path.win32.dirname(executable);
  if (path.win32.basename(executable).toLowerCase() !== exe.toLowerCase()) return { target: null, reason: 'executable-name-mismatch' };
  if (!path.win32.isAbsolute(target)) return { target: null, reason: 'relative-install-directory' };
  let active = false;
  for (const [viewIndex, row] of rows.entries()) {
    if (row.location === null && row.uninstall === null) continue;
    active = true;
    if (!row.location) return { target: null, reason: 'missing-install-location', viewIndex };
    if (!same(row.location, target)) return { target: null, reason: 'install-location-mismatch', viewIndex };
    if (row.uninstall !== `"${path.win32.join(target, uninstaller)}" /currentuser`)
      return { target: null, reason: 'uninstall-command-mismatch', viewIndex };
  }
  return active ? { target } : { target: null, reason: 'no-registration' };
}

type QueryResult = { value: string | null; status: 'parsed' | 'exec-failed' | 'value-missing' | 'not-reg-sz'; code?: string | number; signal?: string; killed?: boolean };
/** Never include an exception message: child-process errors contain command and registry output. */
function errorDetails(error: unknown): { code?: string | number; signal?: string; killed?: boolean } {
  if (!error || typeof error !== 'object') return {};
  const { code, signal, killed } = error as { code?: unknown; signal?: unknown; killed?: unknown };
  return {
    ...(typeof code === 'number' || typeof code === 'string' && /^[a-z0-9_-]{1,64}$/i.test(code) ? { code } : {}),
    ...(typeof signal === 'string' && /^[a-z0-9_-]{1,32}$/i.test(signal) ? { signal } : {}),
    ...(typeof killed === 'boolean' ? { killed } : {})
  };
}

function registrationRejected(executable: string, stage: string, reason: string, details: object = {}): null {
  let cwd: string;
  try { cwd = process.cwd(); } catch { cwd = '[unavailable]'; }
  logWarn('update: Windows installation registration rejected ' + JSON.stringify({
    stage, reason, channel: BUILD_CHANNEL, platform: process.platform, arch: process.arch,
    execPath: process.execPath.slice(0, 2048), executable: executable.slice(0, 2048), cwd: cwd.slice(0, 2048), ...details
  }));
  return null;
}

function query(key: string, value: string, view: string): Promise<QueryResult> {
  const reg = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
  return new Promise(resolve => execFile(reg, ['query', key, '/v', value, `/reg:${view}`],
    { windowsHide: true, timeout: 5000, maxBuffer: 16384 }, (error, stdout) => {
      if (error) { resolve({ value: null, status: 'exec-failed', ...errorDetails(error) }); return; }
      const row = stdout.split(/\r?\n/).find(line => line.trimStart().startsWith(`${value} `));
      const parsed = row?.match(/\sREG_SZ\s+(.+)$/)?.[1]?.trim() ?? null;
      resolve({ value: parsed, status: parsed !== null ? 'parsed' : row ? 'not-reg-sz' : 'value-missing' });
    }));
}

/** Never redirects an unpacked/foreign build to the registered installation. */
export async function currentWindowsInstallTarget(executable = process.execPath): Promise<string | null> {
  if (process.platform !== 'win32') return registrationRejected(executable, 'platform', 'not-windows');
  const queries = await Promise.all(['64', '32'].map(async view => {
    const [location, uninstall] = await Promise.all([
      query(`HKCU\\Software\\${ONECODE_INSTALLER_GUID}`, 'InstallLocation', view),
      query(`HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${ONECODE_INSTALLER_GUID}`, 'UninstallString', view)
    ]);
    return { view, location, uninstall };
  })).catch(error => {
    registrationRejected(executable, 'registry-query', 'query-threw', errorDetails(error));
    throw error;
  });
  const checked = checkRegistration(executable, queries.map(row => ({ location: row.location.value, uninstall: row.uninstall.value })), BUILD_CHANNEL);
  if (checked.target === null) return registrationRejected(executable, 'registration', checked.reason, {
    ...(checked.viewIndex !== undefined ? { rejectedView: queries[checked.viewIndex]?.view } : {}),
    queries: queries.map(row => ({ view: row.view,
      location: { ...row.location, value: undefined }, uninstall: { ...row.uninstall, value: undefined } }))
  });
  const target = checked.target;
  let stage = 'fs-ancestor';
  try {
    // Reject path redirection at every ancestor, including a directory junction.
    for (let node = target; ; node = path.dirname(node)) {
      if ((await lstat(node)).isSymbolicLink()) return registrationRejected(executable, stage, 'redirected-install-ancestor');
      const parent = path.dirname(node); if (parent === node) break;
    }
    stage = 'fs-executable';
    if (!same(await realpath(executable), executable)) return registrationRejected(executable, stage, 'executable-realpath-mismatch');
    stage = 'fs-uninstaller';
    if (!(await lstat(path.join(target, UNINSTALLER))).isFile()) return registrationRejected(executable, stage, 'uninstaller-not-file');
    return target;
  } catch (error) { return registrationRejected(executable, stage, 'filesystem-check-failed', errorDetails(error)); }
}
