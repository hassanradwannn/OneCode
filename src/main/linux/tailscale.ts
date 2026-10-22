import { spawn, type ChildProcess } from 'node:child_process';
import { childEnv } from '../exec.js';
import { locateBinary } from '../tunnel/locate.js';

type Spawn = typeof spawn;

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
