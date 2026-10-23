import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';
import contract from '../resources/updater/hotfix-contract.cjs';
import { assertWindowsPackageIsolation } from './verify-windows-package.mjs';
const output = path.resolve(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'release');
const option = name => {const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1];};
const resources = path.join(output, 'win-unpacked/resources');
assertWindowsPackageIsolation(resources);
const runtime = contract.runtime(JSON.parse(await fs.readFile(path.join(resources, 'updater/runtime.json'), 'utf8')));
const channel = runtime.channel ?? 'stable', prefix = channel === 'beta' ? 'OneCode-Beta' : 'OneCode';
await contract.verify(resources, runtime.files);
const { extractFile } = await import('@electron/asar');
const version = JSON.parse(extractFile(path.join(resources, 'app.asar'), 'package.json')).version;
if (version !== JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8')).version)
  throw Error('Rebuild the application before publishing a hotfix');
let base;
if(process.argv.includes('--with-installer')) {
  const expected=path.join(output,`${prefix}-Base-${runtime.arch}.json`);
  if(!option('--base-file') || path.resolve(option('--base-file'))!==expected) throw Error('Full release must supply its exact base descriptor');
  base=contract.baseRelease(JSON.parse(await fs.readFile(expected,'utf8')));
  if(base.version!==version || await contract.hash(path.join(output,base.installer))!==base.sha256 || (await fs.stat(path.join(output,base.installer))).size!==base.size) throw Error('Base descriptor differs from complete installer');
} else {
  const baseVersion=option('--base-version'), baseTag=option('--base-tag') ?? (channel==='beta'?`beta-v${baseVersion}`:`v${baseVersion}`);
  if(!baseVersion || !/^\d+\.\d+\.\d+$/.test(baseVersion)) throw Error('Specify --base-version with the latest compatible complete release');
  if (baseTag !== (channel==='beta'?`beta-v${baseVersion}`:`v${baseVersion}`)) throw Error('Base release tag does not match this update channel and version');
  const url=`https://github.com/hassanradwannn/OneCode/releases/download/${encodeURIComponent(baseTag)}/`;
  const read=async name=>{const r=await fetch(url+name,{signal:AbortSignal.timeout(30000)});if(!r.ok)throw Error(`Base release ${name} answered ${r.status}`);return Buffer.from(await r.arrayBuffer());};
  const sums=(await read('SHA256SUMS.txt')).toString('utf8'),name=`${prefix}-Base-${runtime.arch}.json`,bytes=await read(name);
  if(!sums.split(/\r?\n/).includes(`${createHash('sha256').update(bytes).digest('hex')}  ${name}`)) throw Error('Base descriptor is not in its release checksums');
  base=contract.baseRelease(JSON.parse(bytes.toString('utf8')));
  if(base.version!==baseVersion || !sums.split(/\r?\n/).includes(`${base.sha256}  ${base.installer}`)) throw Error('Base installer is not in its release checksums');
}
if(base.runtime!==runtime.id || base.arch!==runtime.arch || (base.channel??'stable')!==channel || (channel==='beta'&&base.tag!==`beta-v${base.version}`)) throw Error('Build a complete release: this hotfix changes its native base or channel');
const files = await contract.inventory(resources, contract.mutable), entries = {};
for (const file of files) entries[file.path] = await fs.readFile(contract.location(resources, file.path));
const archive = `${prefix}-Hotfix-${runtime.arch}.zip`, bytes = zipSync(entries, { level: 9 });
const manifest = contract.manifest({ schema: 1, version, platform: 'win32', arch: runtime.arch, runtime: runtime.id, archive, ...(channel==='beta'?{channel}:{}),
  size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), files, base });
await fs.writeFile(path.join(output, archive), bytes);
const manifestName = `${prefix}-Hotfix-${runtime.arch}.json`;
await fs.writeFile(path.join(output, manifestName), JSON.stringify(manifest));
const sumsFile = path.join(output, 'SHA256SUMS.txt');
// A standalone hotfix release must never advertise a stale installer left in release/.
const old = process.argv.includes('--with-installer') ? await fs.readFile(sumsFile, 'utf8') : '';
const sums = old.split(/\r?\n/).filter(line => line && !line.endsWith('  '+archive) && !line.endsWith('  '+manifestName));
for (const name of [archive, manifestName]) sums.push(`${await contract.hash(path.join(output, name))}  ${name}`);
await fs.writeFile(sumsFile, sums.join('\n') + '\n');
console.log(`Verified hotfix ${version}: ${bytes.length} bytes; runtime ${runtime.id}`);
