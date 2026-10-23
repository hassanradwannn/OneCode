import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFile } from '@electron/asar';
import { execFileSync } from 'node:child_process';
import contract from '../resources/updater/hotfix-contract.cjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(process.argv[2] || path.join(root, 'release'));
const version = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
const resources = path.join(output, 'linux-unpacked/resources');
const packaged = JSON.parse(extractFile(path.join(resources, 'app.asar'), 'package.json'));
assert.equal(packaged.version, version);
const extension = JSON.parse(await fs.readFile(path.join(resources, 'extension/manifest.json'), 'utf8'));
assert.equal(extension.version, version);
assert.equal(extension.version_name, version);
const runtime = contract.runtime(JSON.parse(await fs.readFile(path.join(resources, 'updater/runtime.json'), 'utf8')));
assert.equal(runtime.platform, 'linux');
assert.equal(runtime.baseVersion, version);
await contract.verify(resources, runtime.files);

const appImageName = 'OneCode-Linux-' + runtime.arch + '.AppImage';
const debName = 'OneCode-Linux-' + runtime.arch + '.deb';
const appImage = await fs.readFile(path.join(output, appImageName));
const deb = await fs.readFile(path.join(output, debName));
assert.ok(appImage.length > 0 && deb.length > 0, 'Linux release packages must not be empty');
const baseName = 'OneCode-Linux-Base-' + runtime.arch + '.json';
await fs.writeFile(path.join(output, baseName), JSON.stringify(contract.baseRelease({ schema: 2, version, platform: 'linux', arch: runtime.arch,
  runtime: runtime.id, installer: appImageName, size: appImage.length, sha256: await contract.hash(path.join(output, appImageName)) })));

const names = [appImageName, debName, baseName];
const sumsFile = path.join(output, 'SHA256SUMS.txt');
let old = '';
try { old = await fs.readFile(sumsFile, 'utf8'); } catch { }
const replace = new Set(names);
const sums = old.split(/\r?\n/).filter(line => line && ![...replace].some(name => line.endsWith('  ' + name)));
for (const name of names) sums.push((await contract.hash(path.join(output, name))) + '  ' + name);
await fs.writeFile(sumsFile, sums.join('\n') + '\n');
if (!process.argv.includes('--full-only')) execFileSync(process.execPath,
  [path.join(root, 'scripts/write-linux-hotfix-package.mjs'), output, '--with-appimage', '--base-file', path.join(output, baseName)],
  { cwd: root, stdio: 'inherit' });
console.log('Verified ' + version + ': Linux ' + runtime.arch + ' AppImage/DEB, base descriptor and application capsule are ready.');
