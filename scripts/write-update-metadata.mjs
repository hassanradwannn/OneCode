import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

/** Emit a single-architecture channel only after its installer and blockmap exist. */
export async function writeUpdateMetadata(directory, arch, version) {
  if (!['x64', 'arm64'].includes(arch) || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid update target');
  const name = `OneCode-Setup-${arch}.exe`, installer = await fs.readFile(path.join(directory, name));
  const blockmap = await fs.stat(path.join(directory, name + '.blockmap'));
  if (!installer.length || !blockmap.isFile() || !blockmap.size) throw new Error('Update artifacts are incomplete');
  const sha512 = createHash('sha512').update(installer).digest('base64');
  // A rebuild must not leave a previous candidate's downloadable checksum behind.
  const checksum = path.join(directory, name + '.sha256');
  await fs.writeFile(checksum + '.tmp', `${createHash('sha256').update(installer).digest('hex')}  ${name}\n`, 'utf8');
  await fs.rename(checksum + '.tmp', checksum);
  const metadata = { version, files: [{ url: name, sha512, size: installer.length }], path: name, sha512,
    releaseDate: new Date().toISOString() };
  const target = path.join(directory, `latest-${arch}.yml`), pending = `${target}.tmp`;
  await fs.writeFile(pending, yaml.dump(metadata, { lineWidth: -1 }), 'utf8');
  await fs.rename(pending, target);
  return target;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, arch, version] = process.argv.slice(2);
  if (!directory) throw new Error('Supply the output directory, architecture and version');
  console.log(await writeUpdateMetadata(path.resolve(directory), arch, version));
}
