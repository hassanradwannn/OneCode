import { shell } from 'electron';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { childEnv } from '../exec.js';
import { locateBinary } from './locate.js';
import { TAILSCALE_SETUP_ACTIONS, type TailscaleSetupAction } from '../../shared/tailscale-setup.js';
import { startLinuxTailscaleLogin } from '../linux/tailscale.js';

const run = promisify(execFile);
// Exact community repository identity; WinGet retains installer hash checks and OS consent.
// https://learn.microsoft.com/windows/package-manager/winget/install
export const TAILSCALE_INSTALL_ARGS = ['install', '--id', 'Tailscale.Tailscale', '--exact', '--source', 'winget',
  '--interactive', '--no-upgrade', '--accept-source-agreements', '--disable-interactivity'] as const;

async function installWindowsTailscale(): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  if (locateBinary('tailscale')) return true;
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const winget = path.join(local, 'Microsoft', 'WindowsApps', 'winget.exe');
  if (!existsSync(winget)) return false;
  await run(winget, [...TAILSCALE_INSTALL_ARGS], { windowsHide: true, timeout: 600_000,
    maxBuffer: 256 * 1024, env: childEnv() });
  // The ordinary prerequisite owner verifies installation/service readiness. Process exit is not that proof.
  return true;
}

async function openWindowsTailscale(): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  const cli = locateBinary('tailscale');
  if (!cli) return false;
  const gui = path.join(path.dirname(cli), 'tailscale-ipn.exe');
  if (!existsSync(gui)) return false;
  // Let the installed first-party UI own sign-in. Never run `up`, change routes/preferences,
  // consume an auth key, or treat a browser account login as this device's authentication.
  return await shell.openPath(gui) === '';
}

export interface TailscaleSetupDeps {
  install(): Promise<boolean>;
  login(): Promise<boolean>;
  open(url: string): Promise<void>;
}
/** One launch owner shared by MCP and Remote; polling cannot start repeated installers. */
export class TailscaleSetupLauncher {
  private readonly opened = new Set<string>();
  constructor(private readonly deps: TailscaleSetupDeps) {}
  async request(action: TailscaleSetupAction): Promise<void> {
    if (this.opened.has(action.step)) return;
    if (!Object.hasOwn(TAILSCALE_SETUP_ACTIONS, action.step)) return;
    const destination = TAILSCALE_SETUP_ACTIONS[action.step];
    this.opened.add(action.step);
    try {
      if (action.step === 'install' && await this.deps.install()) return;
      if (action.step === 'login' && await this.deps.login()) return;
    } catch { /* A missing/failed native setup falls back once to first-party instructions. */ }
    try { await this.deps.open(destination.url); }
    catch { /* Keep the spent launch: a failed reply cannot prove no browser opened. Manual setup remains available. */ }
  }
}
const launcher = new TailscaleSetupLauncher({ install: installWindowsTailscale,
  login: () => process.platform === 'linux' ? startLinuxTailscaleLogin() : openWindowsTailscale(),
  open: url => shell.openExternal(url) });
/** The prerequisite owner resumes only after actual CLI/account/capability verification. */
export const requestTailscaleSetup = (action: TailscaleSetupAction): Promise<void> => launcher.request(action);
