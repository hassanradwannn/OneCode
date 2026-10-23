import { spawn, type ChildProcess } from 'node:child_process';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import { promisify } from 'node:util';
import { childEnv } from '../exec.js';
import { locateBinary } from '../tunnel/locate.js';

type Spawn = typeof spawn;
const run = promisify(execFile);

export function linuxTailscaleOperatorUsername(username = os.userInfo().username): string {
  const value = username.trim();
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(value)) throw new Error('The Linux user name cannot be used as a Tailscale operator.');
  return value;
}

/**
 * Linux intentionally keeps tailscaled privileged while allowing one named desktop user to use
 * Serve/Funnel without sudo. Ask polkit for that one preference only; never run a shell, `up`, an
 * auth-key command, or any route mutation here. The ordinary tunnel owner re-reads the preference
 * before it is allowed to publish a route.
 */
export async function authorizeLinuxTailscaleOperator(options: {
  platform?: NodeJS.Platform;
  cli?: string | null;
  pkexec?: string;
  username?: string;
  execute?: typeof run;
} = {}): Promise<boolean> {
  if ((options.platform ?? process.platform) !== 'linux') return false;
  const cli = options.cli ?? locateBinary('tailscale');
  const pkexec = options.pkexec ?? '/usr/bin/pkexec';
  if (!cli || !existsSync(cli) || !existsSync(pkexec)) return false;
  const username = linuxTailscaleOperatorUsername(options.username);
  try {
    await (options.execute ?? run)(pkexec, [cli, 'set', `--operator=${username}`], {
      windowsHide: true, timeout: 120_000, maxBuffer: 64 * 1024, env: childEnv()
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Ask the installed first-party Linux client to begin this device's ordinary interactive login.
 * This deliberately does not run `up`, consume an auth key, install packages, or change routes.
 * The existing Tailscale prerequisite owner remains the only proof that login actually finished.
 */
export function startLinuxTailscaleLogin(options: {
  platform?: NodeJS.Platform;
  locate?: () => string | null;
  spawnProcess?: Spawn;
} = {}): Promise<boolean> {
  if ((options.platform ?? process.platform) !== 'linux') return Promise.resolve(false);
  const cli = (options.locate ?? (() => locateBinary('tailscale')))();
  if (!cli) return Promise.resolve(false);
  const launch = options.spawnProcess ?? spawn;
  return new Promise(resolve => {
    let settled = false;
    const finish = (value: boolean, child?: ChildProcess): void => {
      if (settled) return;
      settled = true;
      if (value) child?.unref();
      resolve(value);
    };
    let child: ChildProcess;
    try {
      child = launch(cli, ['login'], { stdio: 'ignore', detached: true, windowsHide: true, env: childEnv() });
    } catch {
      finish(false);
      return;
    }
    child.once('spawn', () => finish(true, child));
    child.once('error', () => finish(false));
  });
}
