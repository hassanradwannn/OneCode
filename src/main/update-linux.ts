import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, readFile, realpath, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import { hash } from '../../resources/updater/hotfix-contract.cjs';
import { processIdentity, successorEnvironment, validate, type LinuxHandoff } from '../../resources/updater/linux-update-helper.cjs';
import { BUILD_CHANNEL } from '../shared/build-channel.js';
import { APP_VERSION } from './version.js';
import { currentAppImageIdentity, installationKind } from './installation.js';
import { logInfo } from './logger.js';
import { packagedApplicationResource } from './application-resources.js';

const noteFile = () => path.join(app.getPath('userData'), 'updates', 'linux-handoff.json');
async function noLinks(file: string): Promise<void> {
  for (let node = file; ; node = path.dirname(node)) {
    if ((await lstat(node)).isSymbolicLink()) throw new Error('The Linux update handoff path is redirected');
    const parent = path.dirname(node); if (parent === node) return;
  }
}
async function atomic(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  await rename(temporary, file);
}

/** Explicit shutdown hands one launch to a runtime that does not live in the disappearing mount. */
export async function startLinuxUpdate(options: {
  version: string; executable: string; digest: string; installation: 'appimage' | 'deb';
  browserUserData?: string; bridgePorts?: string;
}): Promise<void> {
  if (process.platform !== 'linux' || !app.isPackaged) throw new Error('Linux update handoff requires a packaged Linux application');
  const userData = app.getPath('userData'), updates = path.dirname(noteFile());
  await noLinks(userData);
  await mkdir(updates, { recursive: true, mode: 0o700 }); await noLinks(updates);
  const startTicks = processIdentity(process.pid);
  if (!startTicks) throw new Error('The Linux predecessor process identity is unavailable');
  const record = validate({ schema: 1, channel: BUILD_CHANNEL, ...options, userData,
    nonce: randomBytes(32).toString('hex'), pid: process.pid, startTicks, at: Date.now(), status: 'pending' });
  await noLinks(record.executable);
  if (await realpath(record.executable) !== record.executable || await hash(record.executable) !== record.digest)
    throw new Error('The installed Linux successor changed after verification');
  const directory = path.join(updates, `linux-${record.nonce}`);
  await mkdir(directory, { mode: 0o700 });
  const runtime = path.join(directory, 'node'), helper = path.join(directory, 'linux-update-helper.cjs');
  // The helper claims only this fresh receipt. It never resumes a pending launch after restart.
  try {
    await atomic(noteFile(), record);
    for (const [source, destination] of [
      [path.join(process.resourcesPath, 'node', 'bin', 'node'), runtime],
      [packagedApplicationResource('updater', 'linux-update-helper.cjs'), helper]
    ]) {
      await noLinks(source!);
      await copyFile(source!, destination!, constants.COPYFILE_EXCL);
      if (await hash(source!) !== await hash(destination!)) throw new Error('The Linux handoff runtime copy changed');
    }
    await chmod(runtime, 0o700);
    const child = spawn(runtime, [helper, noteFile()], {
      detached: true, stdio: 'ignore', cwd: userData, env: successorEnvironment(record, process.env)
    });
    try {
      await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      const deadline = Date.now() + 5000;
      while (true) {
        const receipt = JSON.parse(await readFile(noteFile(), 'utf8')) as LinuxHandoff;
        if (receipt.nonce !== record.nonce) throw new Error('The Linux handoff receipt changed');
        if (receipt.status === 'waiting-exit') break;
        if (receipt.status === 'failed' || Date.now() >= deadline) throw new Error('The independent Linux launch observer did not become ready');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    } finally { child.unref(); }
  } catch (error) {
    try {
      const receipt = JSON.parse(await readFile(noteFile(), 'utf8')) as LinuxHandoff;
      if (receipt.nonce === record.nonce) await atomic(noteFile(), { ...record, status: 'failed', error: 'The independent Linux update launcher could not become ready' });
    } finally {
      // This invocation exclusively created the directory. Retire only its two known copies.
      for (const file of [helper, runtime]) {
        try { await noLinks(file); if ((await lstat(file)).isFile() && await realpath(file) === file) await unlink(file); } catch { /* No recursive cleanup or foreign-path fallback. */ }
      }
      await rmdir(directory).catch(() => undefined);
    }
    throw error;
  }
  logInfo(`update: Linux handoff armed for ${record.version}; successor startup is not confirmed yet`);
}

/** Native ready-to-show is evidence only for this exact launched profile, installation and version. */
export async function confirmLinuxUpdateWindow(window: { isDestroyed(): boolean; isVisible(): boolean; isMinimized(): boolean }): Promise<void> {
  if (process.platform !== 'linux' || !app.isPackaged) return;
  const nonce = process.argv.find(arg => arg.startsWith('--onecode-linux-update='))?.slice('--onecode-linux-update='.length);
  if (!nonce || !/^[a-f0-9]{64}$/.test(nonce)) return;
  await noLinks(noteFile());
  const record = validate(JSON.parse(await readFile(noteFile(), 'utf8')));
  const executable = installationKind() === 'appimage' ? currentAppImageIdentity()?.target : process.execPath;
  if (record.nonce !== nonce || record.status !== 'launching' || record.channel !== BUILD_CHANNEL || record.version !== APP_VERSION ||
      record.userData !== app.getPath('userData') || record.executable !== executable || record.installation !== installationKind() ||
      !executable || await hash(executable) !== record.digest || window.isDestroyed() || !window.isVisible() || window.isMinimized()) return;
  const startTicks = processIdentity(process.pid);
  if (!startTicks) return;
  await atomic(path.join(path.dirname(noteFile()), 'linux-ready.json'), { nonce, version: APP_VERSION, channel: BUILD_CHANNEL,
    executable, userData: app.getPath('userData'), pid: process.pid, startTicks, visible: true, minimized: false });
  logInfo(`update: Linux successor ${APP_VERSION} confirmed its exact installation and visible ready window`);
}

/** Read-only failure projection; a lost receipt never authorizes another launch. */
export async function linuxUpdateFailure(): Promise<{ version: string; error: string } | null> {
  if (process.platform !== 'linux') return null;
  try {
    await noLinks(noteFile());
    const record = validate(JSON.parse(await readFile(noteFile(), 'utf8')));
    if (record.channel !== BUILD_CHANNEL || record.userData !== app.getPath('userData') || record.status === 'ready') return null;
    if (record.status === 'failed') return { version: record.version, error: record.error?.slice(0, 500) ?? 'The Linux update successor was not confirmed' };
    const current = process.argv.includes(`--onecode-linux-update=${record.nonce}`);
    if (current && record.version !== APP_VERSION)
      return { version: record.version, error: `The Linux update expected ${record.version}, but ${APP_VERSION} started` };
    if (!current && processIdentity(record.pid) !== record.startTicks)
      return { version: record.version, error: 'The previous Linux update successor was not confirmed; no automatic retry was launched' };
  } catch { /* No receipt is not evidence of success or authority to retry. */ }
  return null;
}
