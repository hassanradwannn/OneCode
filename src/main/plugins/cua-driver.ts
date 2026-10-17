import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pluginEnvironment, runInstaller, type InstalledLaunch } from './installer.js';
import { envValue } from '../env.js';

// Integration metadata only. Driver, installers and skills remain upstream downloads.
export const CUA_VERSION = '0.36.0';
export const CUA_REF = '075add55cf938f4e351b74539efa18d4976696ae';
export const CUA_SKILL_URL = `https://github.com/trycua/cua/tree/${CUA_REF}/libs/cua-driver/rust/Skills/cua-driver`;
const run = promisify(execFile);
const scripts = {
  win32: { file: 'install.ps1', sha256: '040985b102e82cbf9464d6df5701343f1dd907eb1c24d52b16bc2eb390cce1ee' },
  unix: { file: '_install-rust.sh', sha256: '7ad1e9ffe30bd6d1298bf04900b4b7ffe5e6578b60fd77cc3135ab38c8ae233f' }
} as const;

/** Desktop launch PATH can predate installation, so inspect the official per-user locations too. */
export function cuaCandidates(platform = process.platform, env = process.env, home = os.homedir()): string[] {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const explicit = envValue(env, 'CUA_DRIVER_PATH');
  if (explicit && !p.isAbsolute(explicit)) throw new Error('CUA_DRIVER_PATH must be an absolute executable path');
  const local = envValue(env, 'LOCALAPPDATA') || p.join(home, 'AppData', 'Local');
  const name = platform === 'win32' ? 'cua-driver.exe' : 'cua-driver';
  return [...new Set([
    ...(explicit ? [explicit] : []),
    ...platform === 'win32' ? [p.join(local, 'Programs', 'Cua', 'cua-driver', 'bin', name),
      p.join(local, 'Programs', 'trycua', 'cua-driver-rs', 'bin', name)] : [],
    ...platform === 'darwin' ? ['/Applications/CuaDriver.app/Contents/MacOS/cua-driver'] : [],
    p.join(home, '.local', 'bin', name),
    ...(envValue(env, 'PATH') ?? '').split(platform === 'win32' ? ';' : ':').filter(v => p.isAbsolute(v)).map(v => p.join(v, name))
  ])];
}

export async function findCuaDriver(): Promise<string | null> {
  for (const candidate of cuaCandidates()) {
    try { if ((await fs.stat(candidate)).isFile()) return candidate; } catch { /* another official location */ }
  }
  return null;
}

export async function downloadCuaInstaller(directory: string, platform = process.platform, fetcher = fetch): Promise<string> {
  const recipe = platform === 'win32' ? scripts.win32 : scripts.unix;
  const response = await fetcher(`https://raw.githubusercontent.com/trycua/cua/${CUA_REF}/libs/cua-driver/scripts/${recipe.file}`,
    { signal: AbortSignal.timeout(60_000), redirect: 'error' });
  if (!response.ok || !response.body) throw new Error('Could not download the official CUA Driver installer');
  const reader = response.body.getReader(); const parts: Uint8Array[] = []; let size = 0;
  for (;;) {
    const chunk = await reader.read(); if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > 256_000) { await reader.cancel(); throw new Error('CUA installer exceeds its size limit'); }
    parts.push(chunk.value);
  }
  const bytes = Buffer.concat(parts, size);
  if (createHash('sha256').update(bytes).digest('hex') !== recipe.sha256) throw new Error('CUA installer checksum mismatch');
  const file = path.join(directory, recipe.file);
  await fs.writeFile(file, bytes, { flag: 'wx', mode: 0o700 });
  return file;
}

async function installDriver(directory: string): Promise<void> {
  const temporary = await fs.mkdtemp(path.join(directory, 'cua-setup-'));
  try {
    const script = await downloadCuaInstaller(temporary);
    if (process.platform === 'win32') {
      const system = process.env.SystemRoot || 'C:\\Windows';
      await runInstaller(path.join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Release', CUA_VERSION, '-NoPathUpdate'], temporary);
    } else {
      // The official installer accepts the exact release pin through this environment variable.
      await runInstaller('/usr/bin/env', [`CUA_DRIVER_RS_VERSION=${CUA_VERSION}`, '/bin/bash', script, '--no-modify-path'], temporary);
    }
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}

export function cuaSocket(status: string): string | null {
  if (!/^Cua Driver daemon is running\s*$/m.test(status)) return null;
  const socket = /^\s*socket:\s*(\S.*?)\s*$/m.exec(status)?.[1];
  if (!socket || /[\r\n\0]/.test(socket)) throw new Error('CUA daemon did not report its endpoint');
  return socket;
}

async function probe(command: string): Promise<string | null> {
  const { stdout } = await run(command, ['status'], { windowsHide: true, timeout: 10_000, maxBuffer: 128_000, env: pluginEnvironment() });
  const socket = cuaSocket(stdout);
  if (!socket && !/^Cua Driver daemon is not running\s*$/m.test(stdout)) throw new Error('Could not verify CUA daemon status');
  return socket;
}

/** Always use an explicit proxy endpoint: default MCP mode on Windows owns a separate runtime. */
let launchPending: Promise<InstalledLaunch> | null = null;
export function cuaLaunch(directory: string, install = false): Promise<InstalledLaunch> {
  if (launchPending) return launchPending;
  const pending = prepareLaunch(directory, install).finally(() => { if (launchPending === pending) launchPending = null; });
  return launchPending = pending;
}
async function prepareLaunch(directory: string, install: boolean): Promise<InstalledLaunch> {
  let command = await findCuaDriver();
  if (!command && install) { await installDriver(directory); command = await findCuaDriver(); }
  if (!command) throw new Error('CUA Driver is missing. Install Computer use from Plugins to set it up.');
  let socket = await probe(command);
  if (!socket) {
    // Kick the existing user service first. Never stop/reconfigure another client's daemon.
    try { await run(command, ['autostart', 'kick'], { windowsHide: true, timeout: 15_000, env: pluginEnvironment() }); } catch { /* unregistered user service */ }
    socket = await probe(command);
    if (!socket) {
      const child = process.platform === 'darwin'
        ? spawn('/usr/bin/open', ['-g', '-a', '/Applications/CuaDriver.app', '--args', 'serve'], { stdio: 'ignore', detached: true })
        : spawn(command, ['serve'], { windowsHide: true, stdio: 'ignore', detached: true, env: pluginEnvironment() });
      // The daemon is shared. Its lifetime is not the plugin transport's lifetime.
      let launchError = false; child.once('error', () => { launchError = true; }); child.unref();
      for (let attempt = 0; attempt < 40 && !socket && !launchError; attempt++) { await delay(250); socket = await probe(command); }
    }
    if (!socket) throw new Error('CUA Driver did not become ready. Open CUA Driver and complete its native setup, then restart this plugin.');
  }
  const { stdout } = await run(command, ['--version'], { windowsHide: true, timeout: 10_000, env: pluginEnvironment() });
  return { command, args: ['mcp', '--socket', socket], version: /\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/.exec(stdout)?.[0] ?? 'installed', license: 'MIT' };
}

export async function installCuaSkill(): Promise<void> {
  const { listManagedSkills } = await import('../skills.js');
  if ((await listManagedSkills()).some(skill => skill.id === 'cua-driver')) return;
  const { importGitHubSkill } = await import('../skill-github.js');
  await importGitHubSkill(CUA_SKILL_URL);
}
