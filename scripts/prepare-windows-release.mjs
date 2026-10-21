import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFile } from '@electron/asar';
import { zipSync, unzipSync } from 'fflate';
import { load as loadYaml } from 'js-yaml';
import { writeUpdateMetadata } from './write-update-metadata.mjs';
import { assertWindowsPackageIsolation } from './verify-windows-package.mjs';
import { execFileSync } from 'node:child_process';

// Assemble only reviewed public inputs from the final package, never local profiles or logs.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(process.argv[2] || path.join(root, 'release'));
const version = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
const resources = path.join(output, 'win-unpacked/resources');
assertWindowsPackageIsolation(resources);
const packaged = JSON.parse(extractFile(path.join(resources, 'app.asar'), 'package.json'));
assert.equal(packaged.version, version);
const extension = path.join(resources, 'extension');
assert.equal(JSON.parse(await fs.readFile(path.join(extension, 'manifest.json'), 'utf8')).version, version);
const entries = {};
async function collect(directory, prefix = '') {
  for (const item of await fs.readdir(directory, { withFileTypes: true })) {
    assert.ok(!item.isSymbolicLink(), 'Companion input cannot be linked');
    const name = prefix + item.name;
    if (/\.map$|\.private\.|(?:^|\/)\.env|\.md$|\.d\.ts$/i.test(name)) continue;
    if (item.isDirectory()) await collect(path.join(directory, item.name), name + '/');
    else {
      const bytes = await fs.readFile(path.join(directory, item.name));
      assert.deepEqual(bytes, await fs.readFile(path.join(root, 'extension', name)), `Stale packaged Companion: ${name}`);
      entries[name] = bytes;
    }
  }
}
await collect(extension);
assert.ok(entries['build-stamp.txt']?.length);
entries.LICENSE = await fs.readFile(path.join(root, 'LICENSE'));
const companionName = `OneCode-Companion-${version}.zip`;
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
await writeUpdateMetadata(output, 'x64', version);
const installer = await fs.readFile(path.join(output, 'OneCode-Setup-x64.exe'));
const metadata = loadYaml(await fs.readFile(path.join(output, 'latest-x64.yml'), 'utf8'));
assert.equal(metadata.version, version);
assert.equal(metadata.files[0].sha512, createHash('sha512').update(installer).digest('base64'));
const names = [
  'OneCode-Setup-x64.exe', 'OneCode-Setup-x64.exe.blockmap', 'latest-x64.yml', companionName,
  'OneCode-Gemini-Skill.zip', 'OneCode-ChatGPT-Skill.zip', 'SKILL.md',
  'WINDOWS-SETUP.md', 'MULTI-PROVIDER-COMPATIBILITY.md'
];
const sums = [];
for (const name of names) {
  const bytes = await fs.readFile(path.join(output, name));
  assert.ok(bytes.length, `Empty release input: ${name}`);
  sums.push(`${createHash('sha256').update(bytes).digest('hex')}  ${name}`);
}
await fs.writeFile(path.join(output, 'SHA256SUMS.txt'), sums.join('\n') + '\n');
execFileSync(process.execPath, [path.join(root, 'scripts/write-hotfix-package.mjs'), output, '--with-installer'], { cwd: root, stdio: 'inherit' });
console.log(`Verified ${version}: ${names.length} public assets; Windows x64 updater metadata and checksums match.`);
