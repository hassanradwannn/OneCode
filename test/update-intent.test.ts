import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { makeTempDir, removeTempDir, faultGate } from './helpers.js';
const state = vi.hoisted(() => ({ directory: '', target: 'D:\\One Code', busy: [] as import('../src/main/update-install.js').UpdateBusyReason[] }));
const spawn = vi.hoisted(() => vi.fn(() => ({ on: vi.fn(), unref: vi.fn() })));
vi.mock('electron', () => ({ app: { isPackaged: true, getPath: () => state.directory } }));
vi.mock('node:child_process', () => ({ execFile: vi.fn(), spawn }));
const bootstrap = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../src/main/update-bootstrap.js', () => ({ startWindowsUpdate: bootstrap }));
vi.mock('../src/main/logger.js', () => ({ logInfo: vi.fn(), logWarn: vi.fn() }));
vi.mock('../src/main/update-registration.js', () => ({ currentWindowsInstallTarget: async () => state.target }));
const busy = vi.hoisted(() => vi.fn(async () => [...state.busy]));
vi.mock('../src/main/update-install.js', () => ({ updateBusyReasons: busy }));
vi.mock('../src/main/update-download.js', () => ({ downloadWindowsUpdate: async (_version: string, _name: string, progress: (value: number) => void) => {
  const file = path.join(state.directory, 'engine-verified.exe'); await writeFile(file, 'new installer'); progress(100); return file;
} }));
const owner = await import('../src/main/update.js');
const version = '99.0.0';
const quit = vi.fn();
let latest = version;
beforeEach(async () => {
  state.directory = await makeTempDir('onecode-install-intent-');
  latest = version; state.target = 'D:\\One Code'; state.busy = [];
  vi.clearAllMocks(); busy.mockImplementation(async () => [...state.busy]);
  owner.resetUpdateForTests(); owner.configureUpdateInstall(quit);
  owner.setInstallFolderAccessForTests(async () => true);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('api.github.com')
    ? new Response(JSON.stringify({ tag_name: `v${latest}` }))
    : new Response(`${createHash('sha256').update('new installer').digest('hex')}  OneCode-Setup-${process.arch}.exe\n`)));
  await owner.checkForUpdates(); expect(owner.updateStatus().stage).toBe('ready');
});
afterEach(async () => { owner.resetUpdateForTests(); vi.useRealTimers(); vi.unstubAllGlobals(); await removeTempDir(state.directory); });

it('downloads in the background but ordinary Quit cannot execute anything', async () => {
  expect(quit).not.toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled();
  await owner.applyStagedUpdate(); expect(spawn).not.toHaveBeenCalled();
  expect(owner.updateStatus()).toMatchObject({ stage: 'ready', downloadPercent: 100 });
  expect(owner.markInstallOnQuit(version)).toBe(false); // cannot bypass the work/intent owner
});
it('binds explicit intent to the displayed version and final verified installation directory', async () => {
  const prepare = vi.fn(async () => undefined);
  owner.configureUpdateInstall(quit, prepare);
  await expect(owner.requestUpdateInstall('98.0.0')).rejects.toThrow(/no longer current/);
  expect(quit).not.toHaveBeenCalled();
  expect(await owner.requestUpdateInstall(version)).toBe('restarting'); expect(quit).toHaveBeenCalledOnce();
  await owner.applyStagedUpdate();
  expect(prepare).toHaveBeenCalledExactlyOnceWith(version);
  expect(bootstrap).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    file: path.join(state.directory, 'updates', version, `OneCode-Setup-${process.arch}.exe`), version,
    target: 'D:\\One Code', elevate: false, pid: process.pid, executable: process.execPath
  }));
  await owner.applyStagedUpdate(); expect(bootstrap).toHaveBeenCalledOnce();
});
it('waits on work, and a cancellation revokes both timer and ordinary-quit authority', async () => {
  vi.useFakeTimers(); state.busy = ['generation', 'automation', 'messages'];
  expect(await owner.requestUpdateInstall(version)).toBe('waiting');
  expect(owner.updateStatus()).toMatchObject({ installRequested: true, busyReasons: state.busy });
  expect(quit).not.toHaveBeenCalled(); expect(owner.cancelUpdateInstall()).toBe(true);
  state.busy = []; await vi.advanceTimersByTimeAsync(10000); await owner.applyStagedUpdate();
  expect(quit).not.toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled();
});
it('rechecks actual work after file/registry waits and only then requests the existing shutdown', async () => {
  vi.useFakeTimers(); busy.mockResolvedValueOnce([]).mockResolvedValueOnce(['tools']);
  expect(await owner.requestUpdateInstall(version)).toBe('waiting'); expect(quit).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(2000);
  await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce()); expect(spawn).not.toHaveBeenCalled();
});
it('a cancelled in-flight projection cannot arm a same-version replacement request', async () => {
  const gate = faultGate();
  busy.mockImplementationOnce(async () => { await gate.hold(); return []; });
  const first = owner.requestUpdateInstall(version);
  await gate.entered;
  owner.cancelUpdateInstall(); state.busy = ['generation'];
  const second = owner.requestUpdateInstall(version); gate.release();
  await Promise.all([first, second]);
  expect(quit).not.toHaveBeenCalled(); expect(owner.updateStatus().busyReasons).toEqual(['generation']);
});
it('withdrawn or changed releases revoke pending intent rather than borrowing it', async () => {
  state.busy = ['generation']; await owner.requestUpdateInstall(version);
  latest = '98.0.0'; await owner.checkForUpdates();
  expect(owner.updateStatus().installRequested).toBe(false);
  state.busy = []; await owner.applyStagedUpdate(); expect(spawn).not.toHaveBeenCalled(); expect(quit).not.toHaveBeenCalled();
});
it('a cold restart reuses verified staged bytes but never restores install intent', async () => {
  state.busy = ['tools']; await owner.requestUpdateInstall(version);
  owner.resetUpdateForTests(); owner.configureUpdateInstall(quit); await owner.checkForUpdates();
  expect(owner.updateStatus().stage).toBe('ready'); expect(owner.updateStatus().installRequested).toBeFalsy();
  await owner.applyStagedUpdate(); expect(spawn).not.toHaveBeenCalled();
});
it.each(['bytes', 'registration', 'projection'] as const)('refuses a changed %s at install admission', async kind => {
  if (kind === 'bytes') await writeFile(path.join(state.directory, 'updates', version, `OneCode-Setup-${process.arch}.exe`), 'tampered');
  if (kind === 'registration') state.target = 'D:\\foreign';
  if (kind === 'projection') busy.mockRejectedValue(new Error('Owner unavailable'));
  await owner.requestUpdateInstall(version);
  expect(quit).not.toHaveBeenCalled(); await owner.applyStagedUpdate(); expect(spawn).not.toHaveBeenCalled();
  if (kind === 'projection') expect(owner.updateStatus().busyReasons).toEqual(['unavailable']);
  else expect(owner.updateStatus().stage).toBe('failed');
});
it('rechecks staged bytes at the final shutdown handoff', async () => {
  await owner.requestUpdateInstall(version);
  await writeFile(path.join(state.directory, 'updates', version, `OneCode-Setup-${process.arch}.exe`), 'tampered');
  await owner.applyStagedUpdate(); expect(spawn).not.toHaveBeenCalled();
});
it('preserves download engine cache and unrelated version staging on a new download', async () => {
  const previous = path.join(state.directory, 'updates', '97.0.0');
  await mkdir(previous, { recursive: true }); await writeFile(path.join(previous, 'baseline.blockmap'), 'preserve');
  latest = '99.0.1'; await owner.checkForUpdates();
  expect(await readFile(path.join(previous, 'baseline.blockmap'), 'utf8')).toBe('preserve');
});
