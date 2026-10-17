import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
const spawn = vi.hoisted(() => vi.fn(() => {
  const child = Object.assign(new EventEmitter(), { unref: vi.fn(), pid: 12345 });
  queueMicrotask(() => child.emit('spawn')); return child;
}));
vi.mock('node:child_process', () => ({ spawn }));
const { startWindowsUpdate } = await import('../src/main/update-bootstrap.js');
const helper = createRequire(import.meta.url)('../resources/updater/windows-update-helper.cjs');
let directory = '';
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); vi.clearAllMocks(); });
async function fixture() {
  directory = await mkdtemp(path.join(tmpdir(), 'onecode-bootstrap-'));
  const target = path.join(directory, 'install with spaces'); const resources = path.join(directory, 'resources');
  await mkdir(target); await mkdir(path.join(resources, 'node'), { recursive: true }); await mkdir(path.join(resources, 'updater'));
  await writeFile(path.join(resources, 'node/node.exe'), 'node runtime');
  await writeFile(path.join(resources, 'updater/windows-update-helper.cjs'), 'bootstrap source');
  const executable = path.join(target, 'OneCode.exe'), file = path.join(directory, 'OneCode-Setup-x64.exe');
  await writeFile(executable, 'installed exe'); await writeFile(file, 'verified installer');
  return { version: '0.2.805', file, digest: createHash('sha256').update('verified installer').digest('hex'), target,
    elevate: false, note: path.join(directory, 'handoff.json'), resources, executable, pid: 777, log: path.join(directory, 'app.log') };
}
it('persists the exact version, digest and custom target before spawning an independent cached runtime', async () => {
  const options = await fixture(); await startWindowsUpdate(options);
  const record = JSON.parse(await readFile(options.note, 'utf8'));
  expect(helper.validate(record)).toMatchObject({ schema: 1, version: '0.2.805', fileVersion: '0.2.8.5', target: options.target, executable: options.executable, digest: options.digest, pid: 777 });
  expect(spawn).toHaveBeenCalledExactlyOnceWith(path.join(directory, 'bootstrap-node.exe'),
    [path.join(directory, 'windows-update-helper.cjs'), options.note], { detached: true, stdio: 'ignore', windowsHide: true });
  expect(await readFile(path.join(directory, 'bootstrap-node.exe'), 'utf8')).toBe('node runtime');
  for (const change of [{ version: '../evil' }, { at: 1 }, { digest: 'wrong' }, { pid: -1 }, { executable: 'C:\\foreign.exe' }])
    expect(() => helper.validate({ ...record, ...change })).toThrow();
});
it('keeps the next compatibility patch installable by the already shipped 0.2.805 bootstrap', async () => {
  const options = await fixture(); options.version = '0.2.806';
  await startWindowsUpdate(options);
  expect(JSON.parse(await readFile(options.note, 'utf8'))).toMatchObject({version:'0.2.806',fileVersion:'0.2.806.0'});
});
it('waits for the old tree, waits for installation, verifies version and then checks the surviving successor', async () => {
  const options = await fixture(); await startWindowsUpdate(options);
  const events: string[] = []; let old = true, launched = false;
  await helper.run(options.note, {
    processes: () => { if (old) { old = false; events.push('old tree'); return [{}]; } return launched ? [{}] : []; },
    registration: () => events.push('registration'), version: () => { events.push('version'); return '0.2.8.5'; },
    shortcuts: () => events.push('shortcuts'),
    execute: async (_file: string, args: string[]) => { events.push('installer start'); expect(args.at(-1)).toBe(`/D=${options.target}`); expect(args).not.toContain('--force-run'); await new Promise(resolve => setTimeout(resolve, 5)); events.push('installer exit'); },
    launch: () => { events.push('launch'); launched = true; void writeFile(options.log, `${new Date().toISOString()} info window loaded\n`); return spawn(); }
  });
  expect(events).toEqual(['old tree', 'registration', 'installer start', 'installer exit', 'registration', 'version', 'shortcuts', 'launch']);
  expect(JSON.parse(await readFile(path.join(directory, 'last-success.json'), 'utf8')).status).toBe('success');
  await expect(readFile(options.note)).rejects.toThrow();
});
it('refuses a success receipt or relaunch when the installer leaves a shortcut tracking its deleted old executable', async () => {
  const options = await fixture(); await startWindowsUpdate(options);
  const launch = vi.fn();
  await expect(helper.run(options.note, { processes: () => [], registration: () => undefined,
    execute: async () => undefined, version: () => '0.2.8.5',
    shortcuts: () => { throw Error('OneCode shortcut points outside the installed app'); }, launch
  })).rejects.toThrow('shortcut points outside');
  expect(launch).not.toHaveBeenCalled();
  expect(JSON.parse(await readFile(options.note, 'utf8')).status).toBe('failed');
  await expect(readFile(path.join(directory, 'last-success.json'))).rejects.toThrow();
});
it('leaves a failed diagnostic and never executes changed staged bytes', async () => {
  const options = await fixture(); await startWindowsUpdate(options); await writeFile(options.file, 'tampered');
  const execute = vi.fn();
  await expect(helper.run(options.note, { processes: () => [], registration: () => undefined, execute })).rejects.toThrow('digest changed');
  expect(execute).not.toHaveBeenCalled();
  expect(JSON.parse(await readFile(options.note, 'utf8'))).toMatchObject({ status: 'failed', version: '0.2.805' });
});

it('keeps 0.2.9.5 compatible with the three-part handoff written by installed 0.2.9', async () => {
  const options = await fixture(); options.version = '0.2.905';
  await startWindowsUpdate(options);
  expect(JSON.parse(await readFile(options.note, 'utf8'))).toMatchObject({version:'0.2.905',fileVersion:'0.2.905.0'});
});
