import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { unzipSync } from 'fflate';
import * as sharedContract from '../../resources/updater/hotfix-contract.cjs';
import { rawFs, rawPromises } from './rawfs.js';
import { BUILD_CHANNEL } from '../shared/build-channel.js';
const contract = sharedContract.withFilesystem(rawFs);
const { readFile, mkdir, writeFile } = rawPromises;

export type HotfixManifest = sharedContract.Manifest;
export async function readHotfixManifest(manifestFile: string, version: string, arch = process.arch, platform = process.platform): Promise<HotfixManifest> {
  const bytes = await readFile(manifestFile);
  if (bytes.length > 256 * 1024) throw Error('Hotfix manifest is too large');
  const manifest = contract.manifest(JSON.parse(bytes.toString('utf8')));
  if (manifest.version !== version || manifest.arch !== arch || manifest.platform !== platform || (manifest.channel ?? 'stable') !== BUILD_CHANNEL) throw Error('Hotfix manifest names another release, platform, architecture or channel');
  return manifest;
}
export async function compatibleHotfix(manifestFile: string, version: string, resources = process.resourcesPath, arch = process.arch, platform = process.platform): Promise<HotfixManifest | null> {
  const manifest = await readHotfixManifest(manifestFile, version, arch, platform);
  let runtime: sharedContract.Runtime;
  try { runtime = contract.runtime(JSON.parse(await readFile(path.join(resources, 'updater/runtime.json'), 'utf8'))); }
  catch { return null; }
  if (!contract.compatibleBase(runtime, manifest)) return null;
  if (manifest.platform === 'linux') return manifest;
  const probe = path.join(resources, `.onecode-hotfix-write-${randomBytes(12).toString('hex')}.tmp`);
  contract.noLinks(probe);
  let handle;
  try { handle = await rawPromises.open(probe, 'wx'); }
  catch { return null; } // A protected install uses the existing installer/UAC path.
  finally { if (handle) { await handle.close(); await rawPromises.unlink(probe); } }
  return manifest;
}

/** Expand only the complete, checksum-verified application snapshot into its own stage. */
export async function stageHotfix(archive: string, manifest: HotfixManifest): Promise<string> {
  manifest = contract.manifest(manifest);
  const bytes = await readFile(archive);
  if (bytes.length !== manifest.size || await contract.hash(archive) !== manifest.sha256) throw Error('Hotfix archive checksum or size differs');
  const expected = new Map(manifest.files.map(file => [file.path, file]));
  const seen = new Set<string>();
  const files = unzipSync(bytes, { filter: file => {
    const entry = expected.get(file.name);
    if (!entry || seen.has(file.name.toLowerCase()) || file.originalSize !== entry.size) throw Error('Hotfix archive contains an unapproved entry');
    seen.add(file.name.toLowerCase()); return true;
  } });
  if (seen.size !== manifest.files.length) throw Error('Hotfix archive is incomplete');
  const root = path.join(path.dirname(archive), 'hotfix-payload');
  contract.noLinks(root);
  for (const entry of manifest.files) {
    const file = contract.location(root, entry.path), contents = files[entry.path];
    if (!contents || contents.length !== entry.size) throw Error('Hotfix entry size differs');
    await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, contents);
  }
  await contract.verify(root, manifest.files);
  const manifestFile = path.join(path.dirname(archive), 'hotfix-manifest.json');
  contract.noLinks(manifestFile);
  await writeFile(manifestFile, JSON.stringify(manifest));
  return manifestFile;
}
