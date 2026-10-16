/** Private Windows plugin runtime, from one pinned official Node archive; never a system install. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { NODE_RUNTIME } from './packaging-versions.mjs';
import { normalizeArch, parseTarget } from './packaging-targets.mjs';
import { fetchWithRetry } from './fetch-retry.mjs';

const repository = path.resolve(import.meta.dirname, '..');
export function nodeRuntimeAsset(arch) {
  arch = normalizeArch(arch);
  const file = `node-${NODE_RUNTIME.version}-win-${arch}.zip`;
  return { file, arch, version: NODE_RUNTIME.version, sha256: NODE_RUNTIME.targets[arch].sha256,
    url: `https://nodejs.org/dist/${NODE_RUNTIME.version}/${file}`,
    checksumUrl: `https://nodejs.org/dist/${NODE_RUNTIME.version}/SHASUMS256.txt` };
}
export function verifyNodeArchive(bytes, checksums, asset) {
  const official = checksums.split(/\r?\n/).find(line => line.trim().endsWith(`  ${asset.file}`))?.trim().split(/\s+/)[0];
  if (official !== asset.sha256 || createHash('sha256').update(bytes).digest('hex') !== asset.sha256)
    throw new Error(`Official Node archive checksum mismatch for ${asset.file}`);
}
function contained(parent, child) {
  const relative = path.relative(parent, child);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Node staging path leaves its owned directory');
  return child;
}
async function cachedDownload(url, file, maxBytes) {
  if (existsSync(file)) return readFile(file);
  const response = await fetchWithRetry(url);
  if (!response.ok || !response.body) throw new Error(`Official Node download failed: HTTP ${response.status}`);
  const reader = response.body.getReader(); const chunks = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { await reader.cancel(); throw new Error('Official Node download exceeded its byte limit'); }
    chunks.push(value);
  }
  const bytes = Buffer.concat(chunks, total); await writeFile(file, bytes); return bytes;
}
export async function stageNodeRuntime(arch) {
  const asset = nodeRuntimeAsset(arch);
  const cache = path.join(repository, 'node_modules', '.cache', 'node-runtime');
  const staging = path.join(repository, 'resources', 'packaging', 'node', 'win32');
  const target = contained(staging, path.join(staging, asset.arch));
  const stage = contained(staging, path.join(staging, `${asset.arch}.stage`));
  const extracted = contained(cache, path.join(cache, `${asset.arch}.extract`));
  await mkdir(cache, { recursive: true }); await mkdir(staging, { recursive: true });
  const sums = await cachedDownload(asset.checksumUrl, path.join(cache, `${asset.version}-SHASUMS256.txt`), 128 * 1024);
  const archive = path.join(cache, asset.file);
  const bytes = await cachedDownload(asset.url, archive, 100 * 1024 * 1024);
  verifyNodeArchive(bytes, sums.toString('utf8'), asset);
  // Every recursive mutation stays within these explicit, normalized build-owned directories.
  await rm(extracted, { recursive: true, force: true }); await mkdir(extracted, { recursive: true });
  await rm(stage, { recursive: true, force: true }); await mkdir(stage, { recursive: true });
  try {
    execFileSync(process.platform === 'win32' ? 'tar.exe' : 'tar', ['-xf', archive, '-C', extracted], { stdio: 'inherit' });
    const names = await readdir(extracted);
    const expected = `node-${asset.version}-win-${asset.arch}`;
    if (names.length !== 1 || names[0] !== expected) throw new Error('Unexpected official Node archive layout');
    const source = path.join(extracted, expected);
    // Keep npm's complete dependency/license tree, the untouched Node executable and its notices.
    for (const file of ['node.exe', 'node_modules', 'LICENSE', 'README.md', 'CHANGELOG.md'])
      await cp(path.join(source, file), path.join(stage, file), { recursive: true });
    for (const file of ['npm', 'npm.cmd', 'npm.ps1', 'npx', 'npx.cmd', 'npx.ps1'])
      if (existsSync(path.join(source, file))) await cp(path.join(source, file), path.join(stage, file));
    const npm = JSON.parse(await readFile(path.join(stage, 'node_modules/npm/package.json'), 'utf8'));
    await writeFile(path.join(stage, 'runtime.json'), JSON.stringify({ version: asset.version, platform: 'win32', arch: asset.arch,
      npm: npm.version, source: asset.url, sha256: asset.sha256 }, null, 2) + '\n');
    await writeFile(path.join(stage, 'SHASUMS256.txt'), `${asset.sha256}  ${asset.file}\n`);
    await rm(target, { recursive: true, force: true }); await rename(stage, target);
    process.stdout.write(`Official Node ${asset.version} win32-${asset.arch} verified and staged with npm ${npm.version}.\n`);
    return target;
  } finally {
    await rm(extracted, { recursive: true, force: true }); await rm(stage, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { platform, arch } = parseTarget();
  if (platform === 'win32') await stageNodeRuntime(arch);
}
