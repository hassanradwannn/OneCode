import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFile } from '@electron/asar';
import { zipSync, unzipSync } from 'fflate';
import { load as loadYaml } from 'js-yaml';
import { writeUpdateMetadata } from './write-update-metadata.mjs';
import { assertWindowsPackageIsolation } from './verify-windows-package.mjs';
import { execFileSync } from 'node:child_process';
import contract from '../resources/updater/hotfix-contract.cjs';
import { prepareChannelExtension } from './prepare-channel-extension.mjs';

// Assemble only reviewed public inputs from the final package, never local profiles or logs.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(process.argv[2] || path.join(root, 'release'));
const version = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
const resources = path.join(output, 'win-unpacked/resources');
assertWindowsPackageIsolation(resources);
const packaged = JSON.parse(extractFile(path.join(resources, 'app.asar'), 'package.json'));
const channel = packaged.onecodeBuildChannel === 'beta' ? 'beta' : 'stable';
const prefix = channel === 'beta' ? 'OneCode-Beta' : 'OneCode';
const tag = channel === 'beta' ? `beta-v${version}` : `v${version}`;
assert.equal(packaged.version, version);
const extension = path.join(resources, 'extension');
assert.equal(JSON.parse(await fs.readFile(path.join(extension, 'manifest.json'), 'utf8')).version, version);
const entries = {};
const packagedNames = new Set();
const expectedExtensionRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'onecode-release-extension-'));
try {
  const expectedExtension = path.join(expectedExtensionRoot, 'extension');
  await fs.cp(path.join(root, 'extension'), expectedExtension, { recursive: true });
  await prepareChannelExtension(expectedExtension, channel);
  async function collectExpected(directory, prefix = '') {
    const names = [];
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
      const name = prefix + item.name;
      if (/\.map$|\.private\.|(?:^|\/)\.env|\.md$|\.d\.ts$/i.test(name)) continue;
      if (item.isDirectory()) names.push(...await collectExpected(path.join(directory, item.name), name + '/'));
      else names.push(name);
    }
    return names;
  }
  async function collect(directory, prefix = '') {
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
      assert.ok(!item.isSymbolicLink(), 'Companion input cannot be linked');
      const name = prefix + item.name;
      if (/\.map$|\.private\.|(?:^|\/)\.env|\.md$|\.d\.ts$/i.test(name)) continue;
      if (item.isDirectory()) await collect(path.join(directory, item.name), name + '/');
      else {
        const bytes = await fs.readFile(path.join(directory, item.name));
        assert.deepEqual(bytes, await fs.readFile(path.join(expectedExtension, name)), `Stale packaged Companion: ${name}`);
        packagedNames.add(name);
        entries[name] = bytes;
      }
    }
  }
  await collect(extension);
  assert.deepEqual([...packagedNames].sort(), (await collectExpected(expectedExtension)).sort(), 'Packaged Companion file set differs from the channel source');
} finally {
  await fs.rm(expectedExtensionRoot, { recursive: true, force: true });
}
assert.ok(entries['build-stamp.txt']?.length);
entries.LICENSE = await fs.readFile(path.join(root, 'LICENSE'));
const companionName = `${prefix}-Companion-${version}.zip`;
const zip = zipSync(entries, { level: 9 });
assert.equal(JSON.parse(Buffer.from(unzipSync(zip)['manifest.json']).toString()).version, version);
await fs.writeFile(path.join(output, companionName), zip);
const skill = await fs.readFile(path.join(root, 'resources/skills/onecode-gemini/SKILL.md'));
assert.deepEqual(skill, await fs.readFile(path.join(resources, 'skills/onecode-gemini/SKILL.md')));
await fs.writeFile(path.join(output, 'SKILL.md'), skill);
await fs.writeFile(path.join(output, 'OneCode-Gemini-Skill.zip'), zipSync({ 'SKILL.md': skill }));
await fs.writeFile(path.join(output, 'OneCode-ChatGPT-Skill.zip'), zipSync({
  'onecode-chatgpt/SKILL.md': await fs.readFile(path.join(root, 'skills/onecode-chatgpt/SKILL.md'))
}));
for (const name of ['WINDOWS-SETUP.md', 'MULTI-PROVIDER-COMPATIBILITY.md'])
  await fs.copyFile(path.join(root, 'docs', name), path.join(output, name));
await writeUpdateMetadata(output, 'x64', version, channel);
const installerName = `${prefix}-Setup-x64.exe`;
const installer = await fs.readFile(path.join(output, installerName));
const metadataName = `${channel === 'beta' ? 'beta-latest' : 'latest'}-x64.yml`;
const metadata = loadYaml(await fs.readFile(path.join(output, metadataName), 'utf8'));
assert.equal(metadata.version, version);
assert.equal(metadata.files[0].sha512, createHash('sha512').update(installer).digest('base64'));
const runtime = contract.runtime(JSON.parse(await fs.readFile(path.join(resources, 'updater/runtime.json'), 'utf8')));
const baseName = `${prefix}-Base-x64.json`;
await fs.writeFile(path.join(output,baseName),JSON.stringify(contract.baseRelease({schema:1,version,platform:'win32',arch:'x64',runtime:runtime.id,installer:installerName,size:installer.length,sha256:createHash('sha256').update(installer).digest('hex'),...(channel==='beta'?{channel,tag}:{})})));
const names = [
  installerName, `${installerName}.blockmap`, metadataName, companionName,
  'OneCode-Gemini-Skill.zip', 'OneCode-ChatGPT-Skill.zip', 'SKILL.md',
  'WINDOWS-SETUP.md', 'MULTI-PROVIDER-COMPATIBILITY.md', baseName
];
const sums = [];
for (const name of names) {
  const bytes = await fs.readFile(path.join(output, name));
  assert.ok(bytes.length, `Empty release input: ${name}`);
  sums.push(`${createHash('sha256').update(bytes).digest('hex')}  ${name}`);
}
await fs.writeFile(path.join(output, 'SHA256SUMS.txt'), sums.join('\n') + '\n');
if(!process.argv.includes('--full-only')) execFileSync(process.execPath, [path.join(root, 'scripts/write-hotfix-package.mjs'), output, '--with-installer','--base-file',path.join(output,baseName)], { cwd: root, stdio: 'inherit' });
console.log(`Verified ${version}: ${names.length} public assets; Windows x64 updater metadata and checksums match.`);
