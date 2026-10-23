import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';
import { extractFile } from '@electron/asar';
import contract from '../resources/updater/hotfix-contract.cjs';

const output = path.resolve(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'release');
const option = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const resources = path.join(output, 'linux-unpacked/resources');
const runtime = contract.runtime(JSON.parse(await fs.readFile(path.join(resources, 'updater/runtime.json'), 'utf8')));
const channel = runtime.channel ?? 'stable', prefix = channel === 'beta' ? 'OneCode-Beta' : 'OneCode';
if (runtime.platform !== 'linux') throw Error('The Linux hotfix publisher requires a Linux packaged runtime');
await contract.verify(resources, runtime.files);
const version = JSON.parse(extractFile(path.join(resources, 'app.asar'), 'package.json')).version;
if (version !== JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8')).version)
  throw Error('Rebuild the Linux application before publishing a hotfix');

let base;
if (process.argv.includes('--with-appimage')) {
  const expected = path.join(output, `${prefix}-Linux-Base-${runtime.arch}.json`);
  if (!option('--base-file') || path.resolve(option('--base-file')) !== expected) throw Error('Full Linux release must supply its exact base descriptor');
  base = contract.baseRelease(JSON.parse(await fs.readFile(expected, 'utf8')));
  if (base.platform !== 'linux' || base.version !== version || await contract.hash(path.join(output, base.installer)) !== base.sha256 ||
      (await fs.stat(path.join(output, base.installer))).size !== base.size) throw Error('Linux base descriptor differs from complete AppImage');
} else {
  const baseVersion = option('--base-version'), baseTag = option('--base-tag') ?? (channel==='beta'?`beta-v${baseVersion}`:`v${baseVersion}`);
  if (!baseVersion || !/^\d+\.\d+\.\d+$/.test(baseVersion)) throw Error('Specify --base-version with the latest compatible complete Linux release');
  if (baseTag !== (channel==='beta'?`beta-v${baseVersion}`:`v${baseVersion}`)) throw Error('Base release tag does not match this update channel and version');
  const url = 'https://github.com/hassanradwannn/OneCode/releases/download/' + encodeURIComponent(baseTag) + '/';
  const read = async name => { const r = await fetch(url + name, { signal: AbortSignal.timeout(30000) }); if (!r.ok) throw Error('Base release ' + name + ' answered ' + r.status); return Buffer.from(await r.arrayBuffer()); };
  const sums = (await read('SHA256SUMS.txt')).toString('utf8');
  const name = `${prefix}-Linux-Base-${runtime.arch}.json`;
  const bytes = await read(name);
  if (!sums.split(/\r?\n/).includes(createHash('sha256').update(bytes).digest('hex') + '  ' + name)) throw Error('Linux base descriptor is not in its release checksums');
  base = contract.baseRelease(JSON.parse(bytes.toString('utf8')));
  if (base.platform !== 'linux' || base.version !== baseVersion || !sums.split(/\r?\n/).includes(base.sha256 + '  ' + base.installer))
    throw Error('Linux base AppImage is not in its release checksums');
}
if (base.runtime !== runtime.id || base.arch !== runtime.arch || (base.channel??'stable')!==channel || (channel==='beta'&&base.tag!==`beta-v${base.version}`)) throw Error('Build a complete Linux release: this hotfix changes its immutable runtime or channel');

const files = await contract.inventory(resources, name => contract.mutable(name, 'linux'));
const entries = {};
for (const file of files) entries[file.path] = await fs.readFile(contract.location(resources, file.path));
const archive = `${prefix}-Linux-Hotfix-${runtime.arch}.zip`;
const bytes = zipSync(entries, { level: 9 });
const manifest = contract.manifest({ schema: 2, version, platform: 'linux', arch: runtime.arch, runtime: runtime.id, archive, ...(channel==='beta'?{channel}:{}),
  size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), files, base });
await fs.writeFile(path.join(output, archive), bytes);
const manifestName = `${prefix}-Linux-Hotfix-${runtime.arch}.json`;
await fs.writeFile(path.join(output, manifestName), JSON.stringify(manifest));

const sumsFile = path.join(output, 'SHA256SUMS.txt');
let old = '';
try { old = await fs.readFile(sumsFile, 'utf8'); } catch { }
const linuxFull = [`${prefix}-Linux-${runtime.arch}.AppImage`, `${prefix}-Linux-${runtime.arch}.deb`, `${prefix}-Linux-Base-${runtime.arch}.json`];
const preserveFull = process.argv.includes('--with-appimage');
const filtered = old.split(/\r?\n/).filter(line => line && !line.endsWith('  ' + archive) && !line.endsWith('  ' + manifestName) &&
  (preserveFull || !linuxFull.some(name => line.endsWith('  ' + name))));
for (const name of [archive, manifestName]) filtered.push((await contract.hash(path.join(output, name))) + '  ' + name);
await fs.writeFile(sumsFile, filtered.join('\n') + '\n');
console.log('Verified Linux hotfix ' + version + ': ' + bytes.length + ' bytes; runtime ' + runtime.id);
