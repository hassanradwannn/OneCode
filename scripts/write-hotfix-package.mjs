import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';
import contract from '../resources/updater/hotfix-contract.cjs';
import { assertWindowsPackageIsolation } from './verify-windows-package.mjs';
const output = path.resolve(process.argv[2] || 'release');
const resources = path.join(output, 'win-unpacked/resources');
assertWindowsPackageIsolation(resources);
const runtime = contract.runtime(JSON.parse(await fs.readFile(path.join(resources, 'updater/runtime.json'), 'utf8')));
await contract.verify(resources, runtime.files);
const { extractFile } = await import('@electron/asar');
const version = JSON.parse(extractFile(path.join(resources, 'app.asar'), 'package.json')).version;
if (version !== JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8')).version)
  throw Error('Rebuild the application before publishing a hotfix');
const files = await contract.inventory(resources, contract.mutable), entries = {};
for (const file of files) entries[file.path] = await fs.readFile(contract.location(resources, file.path));
const archive = `OneCode-Hotfix-${runtime.arch}.zip`, bytes = zipSync(entries, { level: 9 });
const manifest = contract.manifest({ schema: 1, version, platform: 'win32', arch: runtime.arch, runtime: runtime.id, archive,
  size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), files });
await fs.writeFile(path.join(output, archive), bytes);
const manifestName = `OneCode-Hotfix-${runtime.arch}.json`;
await fs.writeFile(path.join(output, manifestName), JSON.stringify(manifest));
const sumsFile = path.join(output, 'SHA256SUMS.txt');
// A standalone hotfix release must never advertise a stale installer left in release/.
const old = process.argv.includes('--with-installer') ? await fs.readFile(sumsFile, 'utf8') : '';
const sums = old.split(/\r?\n/).filter(line => line && !line.endsWith('  '+archive) && !line.endsWith('  '+manifestName));
for (const name of [archive, manifestName]) sums.push(`${await contract.hash(path.join(output, name))}  ${name}`);
await fs.writeFile(sumsFile, sums.join('\n') + '\n');
console.log(`Verified hotfix ${version}: ${bytes.length} bytes; runtime ${runtime.id}`);
