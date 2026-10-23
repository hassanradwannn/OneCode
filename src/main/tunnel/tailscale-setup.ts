import { shell } from 'electron';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { childEnv } from '../exec.js';
import { locateBinary } from './locate.js';
import { TAILSCALE_SETUP_ACTIONS, type TailscaleSetupAction } from '../../shared/tailscale-setup.js';
import { authorizeLinuxTailscaleOperator, startLinuxTailscaleLogin } from '../linux/tailscale.js';

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
  operator?(): Promise<boolean>;
  open(url: string): Promise<void>;
}
/** One launch owner shared by MCP and Remote; polling cannot start repeated installers. */
export class TailscaleSetupLauncher {
  private readonly opened = new Set<string>();
  private readonly pending = new Map<string, Promise<boolean>>();
  constructor(private readonly deps: TailscaleSetupDeps) {}
  async request(action: TailscaleSetupAction, options: { retry?: boolean } = {}): Promise<boolean> {
    if (!Object.hasOwn(TAILSCALE_SETUP_ACTIONS, action.step)) return false;
    const pending = this.pending.get(action.step);
    if (pending) return options.retry ? pending : false;
    if (this.opened.has(action.step) && !options.retry) return false;
    const task = this.launch(action).finally(() => {
      if (this.pending.get(action.step) === task) this.pending.delete(action.step);
    });
    this.pending.set(action.step, task);
    return task;
  }
  private async launch(action: TailscaleSetupAction): Promise<boolean> {
    const destination = TAILSCALE_SETUP_ACTIONS[action.step];
    this.opened.add(action.step);
    try {
      if (action.step === 'install' && await this.deps.install()) return true;
      if (action.step === 'login' && await this.deps.login()) return true;
      // Operator authorization is an OS action, not a documentation action. A cancelled or
      // unavailable polkit prompt must never be reported as handled by opening a web page.
      if (action.step === 'operator') return await this.deps.operator?.() === true;
    } catch {
      if (action.step === 'operator') return false;
      // A missing/failed install/login helper can still fall back once to first-party setup.
    }
    try { await this.deps.open(destination.url); return true; }
    catch { return false; /* A failed reply cannot prove no browser opened; keep the spent launch. */ }
  }
}
const launcher = new TailscaleSetupLauncher({ install: installWindowsTailscale,
  login: () => process.platform === 'linux' ? startLinuxTailscaleLogin() : openWindowsTailscale(),
  operator: () => authorizeLinuxTailscaleOperator(),
  open: async url => {
    // Setup links follow OneCode's selected browser family instead of silently handing them to
    // the OS default (for example Firefox when the user selected Brave in OneCode).
    const { openInPreferredBrowser } = await import('../browser.js');
    await openInPreferredBrowser(url, { reveal: true });
  } });
/** The prerequisite owner resumes only after actual CLI/account/capability verification. */
export const requestTailscaleSetup = (action: TailscaleSetupAction): Promise<boolean> => launcher.request(action);
/** Explicit UI retry: coalesces an in-flight prompt but may retry a previously cancelled action. */
export const retryTailscaleSetup = (action: TailscaleSetupAction): Promise<boolean> => launcher.request(action, { retry: true });
