import { randomBytes } from 'node:crypto';
import path from 'node:path';
import * as sharedContract from '../../resources/updater/hotfix-contract.cjs';
import { app } from 'electron';
import { rawFs, rawPromises } from './rawfs.js';

const contract = sharedContract.withFilesystem(rawFs);
const { copyFile, mkdir, readFile, rename, rm, writeFile, lstat } = rawPromises;

async function atomicJson(file: string, value: unknown): Promise<void> {
  const temp = `${file}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
  await rename(temp, file);
}

async function existingActive(file: string): Promise<unknown | null> {
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    return JSON.parse(await readFile(file, 'utf8')) as unknown;
  } catch { return null; }
}

/**
 * Activates a fully verified Linux application snapshot without mutating the AppImage or DEB.
 * The immutable bootstrap validates this same inventory again before executing it, and its
 * launching marker rolls back if the successor dies before a ready main window confirms startup.
 */
export async function activateLinuxHotfix(manifestFile: string): Promise<void> {
  if (process.platform !== 'linux' || !app.isPackaged) throw new Error('Linux application hotfixes require a packaged Linux build');
  const manifest = contract.manifest(JSON.parse(await readFile(manifestFile, 'utf8')));
  if (manifest.platform !== 'linux') throw new Error('The staged hotfix is not a Linux application layer');
  const runtimeFile = path.join(process.resourcesPath, 'updater', 'runtime.json');
  const runtime = contract.runtime(JSON.parse(await readFile(runtimeFile, 'utf8')));
  if (runtime.platform !== 'linux' || !runtime.baseVersion || !contract.compatibleBase(runtime, manifest))
    throw new Error('The Linux hotfix does not match this complete runtime');

  const payload = path.join(path.dirname(manifestFile), 'hotfix-payload');
  contract.noLinks(payload);
  await contract.verify(payload, manifest.files);

  const layers = path.join(app.getPath('userData'), 'application-layers');
  contract.noLinks(layers);
  await mkdir(layers, { recursive: true });
  contract.noLinks(layers);
  const launching = path.join(layers, 'launching.json');
  try {
    const stat = await lstat(launching);
    if (stat.isFile()) throw new Error('The current Linux application layer has not finished startup');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const directory = `${manifest.version}-${manifest.runtime.slice(0, 16)}`;
  const final = path.join(layers, directory);
  const stage = path.join(layers, `.stage-${directory}-${randomBytes(8).toString('hex')}`);
  contract.noLinks(stage);
  await mkdir(stage, { recursive: false });
  try {
    for (const entry of manifest.files) {
      const source = contract.location(payload, entry.path), destination = contract.location(stage, entry.path);
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(source, destination);
    }
    await contract.verify(stage, manifest.files);
    try { contract.noLinks(final); await rm(final, { recursive: true, force: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await rename(stage, final);
  } catch (error) {
    await rm(stage, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  const activeFile = path.join(layers, 'active.json'), rollbackFile = path.join(layers, 'rollback.json');
  contract.noLinks(activeFile); contract.noLinks(rollbackFile);
  await atomicJson(rollbackFile, { schema: 1, active: await existingActive(activeFile) });
  await atomicJson(activeFile, { schema: 2, version: manifest.version, runtime: runtime.id, baseVersion: runtime.baseVersion, directory, files: manifest.files });
}
