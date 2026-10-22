import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

export interface LocalBetaUpdateConfig {
  root: string;
  branch: string;
  remote: string;
  helper: string;
  launcher: string;
  profile: string;
  browserProfile: string;
  prepareExtension: string;
}

export interface LocalBetaUpdateInspection {
  currentRevision: string;
  latestRevision: string | null;
  relation: 'current' | 'local-ahead' | 'remote-ahead';
}

type CommandResult = { stdout: string; stderr: string; exitCode: number };
type Runner = (command: string, args: readonly string[], cwd: string, timeoutMs?: number) => Promise<CommandResult>;

const HASH = /^[0-9a-f]{40}$/i;
const SAFE_NAME = /^[A-Za-z0-9._/-]{1,120}$/;

function absoluteWindowsPath(label: string, value: string): string {
  if (!path.win32.isAbsolute(value)) throw new Error(`${label} must be an absolute Windows path.`);
  return path.win32.normalize(value);
}

export function localBetaUpdateConfig(env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform): LocalBetaUpdateConfig | null {
  const root = env.ONECODE_BETA_LOCAL_ROOT?.trim();
  if (!root) return null;
  if (platform !== 'win32') throw new Error('The local OneCode Beta updater is configured only for Windows.');
  const branch = env.ONECODE_BETA_BRANCH?.trim() || 'beta';
  const remote = env.ONECODE_BETA_REMOTE?.trim() || 'origin';
  if (!SAFE_NAME.test(branch) || branch.startsWith('-') || branch.includes('..')) throw new Error('ONECODE_BETA_BRANCH is invalid.');
  if (!SAFE_NAME.test(remote) || remote.startsWith('-') || remote.includes('..')) throw new Error('ONECODE_BETA_REMOTE is invalid.');
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} is required for the local OneCode Beta updater.`);
    return absoluteWindowsPath(name, value);
  };
  return {
    root: absoluteWindowsPath('ONECODE_BETA_LOCAL_ROOT', root), branch, remote,
    helper: required('ONECODE_BETA_UPDATE_HELPER'), launcher: required('ONECODE_BETA_LAUNCHER'),
    profile: required('ONECODE_BETA_PROFILE'), browserProfile: required('ONECODE_BETA_BROWSER_PROFILE'),
    prepareExtension: required('ONECODE_BETA_PREPARE_EXTENSION')
  };
}

const run: Runner = (command, args, cwd, timeoutMs = 60_000) => new Promise((resolve, reject) => {
  execFile(command, [...args], { cwd, windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024 },
    (error, stdout, stderr) => {
      if (!error) { resolve({ stdout: String(stdout), stderr: String(stderr), exitCode: 0 }); return; }
      const code = (error as NodeJS.ErrnoException & { code?: unknown }).code;
      if (typeof code !== 'number') { reject(error); return; }
      resolve({ stdout: String(stdout), stderr: String(stderr), exitCode: code });
    });
});

async function git(config: LocalBetaUpdateConfig, args: readonly string[], runner: Runner): Promise<CommandResult> {
  return runner('git.exe', args, config.root);
}

function cleanHash(value: string, label: string): string {
  const hash = value.trim().toLowerCase();
  if (!HASH.test(hash)) throw new Error(`${label} did not resolve to one Git commit.`);
  return hash;
}

async function ancestor(config: LocalBetaUpdateConfig, older: string, newer: string, runner: Runner): Promise<boolean> {
  const result = await git(config, ['merge-base', '--is-ancestor', older, newer], runner);
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  throw new Error(result.stderr.trim() || 'Git could not compare the Beta branch revisions.');
}

export async function inspectLocalBetaUpdate(config: LocalBetaUpdateConfig,
  runner: Runner = run): Promise<LocalBetaUpdateInspection> {
  const branch = (await git(config, ['rev-parse', '--abbrev-ref', 'HEAD'], runner)).stdout.trim();
  if (branch !== config.branch) throw new Error(`OneCode Beta is on ${branch || 'no branch'}, not ${config.branch}.`);
  const currentRevision = cleanHash((await git(config, ['rev-parse', 'HEAD'], runner)).stdout, 'The local Beta branch');
  const dirty = (await git(config, ['status', '--porcelain=v1', '--untracked-files=no'], runner)).stdout.trim();
  const fetched = await git(config, ['fetch', '--quiet', config.remote, config.branch], runner);
  if (fetched.exitCode !== 0) throw new Error(fetched.stderr.trim() || `Could not fetch ${config.remote}/${config.branch}.`);
  const remoteRevision = cleanHash((await git(config, ['rev-parse', `${config.remote}/${config.branch}`], runner)).stdout,
    `The ${config.remote}/${config.branch} branch`);
  if (remoteRevision === currentRevision) return { currentRevision, latestRevision: null, relation: 'current' };
  if (await ancestor(config, remoteRevision, currentRevision, runner)) return { currentRevision, latestRevision: null, relation: 'local-ahead' };
  if (!await ancestor(config, currentRevision, remoteRevision, runner)) {
    throw new Error(`The local ${config.branch} branch diverged from ${config.remote}/${config.branch}; update it manually so no work is overwritten.`);
  }
  if (dirty) throw new Error('OneCode Beta has tracked local changes. Commit or stash them before applying a branch update.');
  return { currentRevision, latestRevision: remoteRevision, relation: 'remote-ahead' };
}

export async function verifyLocalBetaUpdate(config: LocalBetaUpdateConfig, currentRevision: string,
  targetRevision: string, runner: Runner = run): Promise<void> {
  if (!HASH.test(currentRevision) || !HASH.test(targetRevision)) throw new Error('The staged Beta revision is invalid.');
  const branch = (await git(config, ['rev-parse', '--abbrev-ref', 'HEAD'], runner)).stdout.trim();
  const current = cleanHash((await git(config, ['rev-parse', 'HEAD'], runner)).stdout, 'The local Beta branch');
  const dirty = (await git(config, ['status', '--porcelain=v1', '--untracked-files=no'], runner)).stdout.trim();
  if (branch !== config.branch || current !== currentRevision || dirty) throw new Error('The Beta working tree changed after the update check. Check for updates again.');
  const target = await git(config, ['cat-file', '-e', `${targetRevision}^{commit}`], runner);
  if (target.exitCode !== 0 || !await ancestor(config, currentRevision, targetRevision, runner)) {
    throw new Error('The staged Beta revision is no longer a safe fast-forward from this checkout.');
  }
}

export async function startLocalBetaUpdate(config: LocalBetaUpdateConfig, currentRevision: string,
  targetRevision: string, parentPid: number): Promise<void> {
  for (const [label, file] of [['update helper', config.helper], ['Beta launcher', config.launcher], ['extension preparer', config.prepareExtension]] as const) {
    if (!existsSync(file)) throw new Error(`The local Beta ${label} is missing: ${file}`);
  }
  const child = spawn('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', config.helper,
    '-Root', config.root, '-Branch', config.branch, '-Remote', config.remote,
    '-ExpectedCurrent', currentRevision, '-ExpectedTarget', targetRevision,
    '-Launcher', config.launcher, '-Profile', config.profile, '-BrowserProfile', config.browserProfile,
    '-PrepareExtension', config.prepareExtension, '-ParentPid', String(parentPid)
  ], { cwd: path.dirname(config.helper), detached: true, stdio: 'ignore', windowsHide: true });
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
}
