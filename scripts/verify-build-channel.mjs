import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import yaml from 'js-yaml';
import contract from '../resources/updater/hotfix-contract.cjs';
import { writeUpdateMetadata } from './write-update-metadata.mjs';
import { prepareChannelExtension } from './prepare-channel-extension.mjs';
import { extensionStamp, STAMP_FILE } from './write-extension-stamp.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const betaBuilder = yaml.load(await fs.readFile(path.join(root, 'electron-builder.beta.yml'), 'utf8'));
assert.equal(betaBuilder.extends, 'electron-builder.yml');
assert.equal(betaBuilder.productName, 'OneCode Beta');
assert.equal(betaBuilder.appId, 'io.onecode.desktop.beta');
assert.equal(betaBuilder.nsis.guid, '35baded0-d4e2-5fee-872a-11b461352695');
assert.equal(betaBuilder.publish.updaterCacheDirName, 'onecode-beta-updater');
assert.equal(betaBuilder.deb.packageName, 'onecode-beta');

const extensionScratch = await fs.mkdtemp(path.join(os.tmpdir(), 'onecode-beta-companion-'));
try {
  const extension = path.join(extensionScratch, 'extension');
  await fs.cp(path.join(root, 'extension'), extension, { recursive: true });
  await prepareChannelExtension(extension, 'beta');
  const companion = JSON.parse(await fs.readFile(path.join(extension, 'manifest.json'), 'utf8'));
  const background = await fs.readFile(path.join(extension, 'background.js'), 'utf8');
  const ports = [48765, 48766, 48767, 48768, 48769, 49765, 49766, 49767, 49768, 49769, 59765, 59766, 59767, 59768, 59769];
  assert.equal(companion.name, 'OneCode Beta Companion');
  assert.equal(companion.version_name, `${companion.version} Beta`);
  assert.deepEqual(companion.host_permissions.filter(value => value.startsWith('http://127.0.0.1:')),
    ports.map(port => `http://127.0.0.1:${port}/*`));
  assert.match(background, new RegExp(`^const PORTS = \\[${ports.join(', ')}\\];$`, 'm'));
  assert.equal((await fs.readFile(path.join(extension, STAMP_FILE), 'utf8')).trim(), extensionStamp(extension));
} finally {
  await fs.rm(extensionScratch, { recursive: true, force: true });
}

const sum = 'a'.repeat(64), files = [{ path: 'runtime.bin', size: 1, sha256: sum }];
const stableRuntime = contract.runtime({ schema: 1, platform: 'win32', arch: 'x64', electron: '44.3.0', files,
  id: contract.runtimeId('x64', files, '44.3.0') });
const betaRuntime = contract.runtime({ schema: 1, platform: 'win32', arch: 'x64', electron: '44.3.0', files, baseVersion: '0.5.1', channel: 'beta',
  id: contract.runtimeId('win32', 'x64', files, '44.3.0', undefined, 'beta') });
const betaBase = contract.baseRelease({ schema: 1, version: '0.5.1', channel: 'beta', tag: 'beta-v0.5.1', platform: 'win32', arch: 'x64',
  runtime: betaRuntime.id, installer: 'OneCode-Beta-Setup-x64.exe', sha256: sum, size: 1 });
const betaManifest = contract.manifest({ schema: 1, version: '0.5.2', channel: 'beta', platform: 'win32', arch: 'x64', runtime: betaRuntime.id,
  archive: 'OneCode-Beta-Hotfix-x64.zip', sha256: sum, size: 1, files: [{ path: 'app.asar', size: 1, sha256: sum }], base: betaBase });
assert.equal(contract.compatibleBase(betaRuntime, betaManifest), true);
assert.equal(contract.compatibleBase(stableRuntime, betaManifest), false);
assert.throws(() => contract.baseRelease({ ...betaBase, tag: 'v0.5.1' }), /Invalid full release descriptor/);
assert.throws(() => contract.manifest({ ...betaManifest, archive: 'OneCode-Hotfix-x64.zip' }), /Invalid hotfix manifest/);

const helper = require('../resources/updater/windows-update-helper.cjs');
assert.equal(helper.uninstallerName('beta'), 'Uninstall onecode-beta.exe');
assert.equal(helper.uninstallerName('stable'), 'Uninstall OneCode.exe');
const handoff = { schema: 1, channel: 'beta', version: '0.5.2', fileVersion: '0.5.2.0', digest: sum, pid: 10, at: Date.now(),
  installer: 'C:\\Users\\tester\\AppData\\Local\\OneCode Beta\\updates\\OneCode-Beta-Setup-x64.exe',
  target: 'C:\\Users\\tester\\AppData\\Local\\Programs\\OneCode Beta',
  executable: 'C:\\Users\\tester\\AppData\\Local\\Programs\\OneCode Beta\\onecode-beta.exe',
  log: 'C:\\Users\\tester\\AppData\\Local\\OneCode Beta\\app.log' };
assert.equal(helper.validate(handoff).channel, 'beta');
assert.throws(() => helper.validate({ ...handoff, installer: handoff.installer.replace('OneCode-Beta-Setup', 'OneCode-Setup') }), /Invalid or expired update handoff/);

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'onecode-beta-feed-'));
try {
  const extension = path.join(directory, 'extension');
  await fs.mkdir(extension);
  await fs.copyFile(path.join(root, 'extension/manifest.json'), path.join(extension, 'manifest.json'));
  await fs.copyFile(path.join(root, 'extension/background.js'), path.join(extension, 'background.js'));
  await prepareChannelExtension(extension, 'beta');
  const manifest = JSON.parse(await fs.readFile(path.join(extension, 'manifest.json'), 'utf8'));
  assert.equal(manifest.name, 'OneCode Beta Companion');
  assert.match(manifest.version_name, / Beta$/);
  assert.equal(manifest.host_permissions.some(value => value.includes(':28765/')), false);
  assert.equal(manifest.host_permissions.includes('http://127.0.0.1:48765/*'), true);
  const background = await fs.readFile(path.join(extension, 'background.js'), 'utf8');
  assert.match(background, /const PORTS = \[48765,/);
  assert.match(background, /const BACKGROUND_GROUP_TITLE = 'OneCode Beta';/);
  assert.equal((await fs.readFile(path.join(extension, 'build-stamp.txt'), 'utf8')).trim(), extensionStamp(extension));
  const installerName = 'OneCode-Beta-Setup-x64.exe';
  await fs.writeFile(path.join(directory, installerName), 'test-installer');
  await fs.writeFile(path.join(directory, `${installerName}.blockmap`), 'blockmap');
  const betaMetadata = await writeUpdateMetadata(directory, 'x64', '0.5.1', 'beta');
  assert.equal(path.basename(betaMetadata), 'beta-latest-x64.yml');
  assert.equal(await fs.access(path.join(directory, 'latest-x64.yml')).then(() => true, () => false), false);
} finally { await fs.rm(directory, { recursive: true, force: true }); }

console.log('Beta product, hotfix and Windows update feeds are isolated from stable.');
