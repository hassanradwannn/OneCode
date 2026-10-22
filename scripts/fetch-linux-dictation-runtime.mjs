/**
 * Stage OneCode's small offline Linux dictation payload.
 *
 * Ubuntu 22.04's PocketSphinx Python bindings are tiny, while the English model is the bulk of
 * the payload.  Package those exact, checksum-pinned binaries/model instead of making AppImage
 * users install python3-pocketsphinx at runtime.  Python itself and the PulseAudio/PipeWire
 * compatibility client remain platform prerequisites; no package-manager mutation happens here
 * or at application runtime.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { zstdDecompressSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchWithRetry } from './fetch-retry.mjs';
import { LINUX_DICTATION_RUNTIME } from './packaging-versions.mjs';
import { parseTarget } from './packaging-targets.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cacheRoot = path.join(root, 'node_modules', '.cache', 'linux-dictation');
const stagingRoot = path.join(root, 'resources', 'packaging', 'dictation', 'linux');
const ARCHIVE = 'https://archive.ubuntu.com/ubuntu/';
const PORTS = 'https://ports.ubuntu.com/ubuntu-ports/';

async function verifiedDownload(asset, arch) {
  await mkdir(cacheRoot, { recursive: true });
  const target = path.join(cacheRoot, asset.file);
  let bytes = existsSync(target) ? await readFile(target) : null;
  if (!bytes || createHash('sha256').update(bytes).digest('hex') !== asset.sha256) {
    await rm(target, { force: true });
    const base = asset === LINUX_DICTATION_RUNTIME.packages.model || arch === 'x64' ? ARCHIVE : PORTS;
    const response = await fetchWithRetry(new URL(asset.path, base).href, {
      headers: { 'user-agent': 'onecode-linux-packager' }
    });
    if (!response.ok) throw new Error(`${asset.file} -> HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256)
      throw new Error(`Integrity mismatch for ${asset.file}`);
    await writeFile(target, bytes);
  }
  return target;
}

/** Extract the regular files from a ustar stream, ignoring package symlinks and metadata. */
async function extractTar(tar, destination) {
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const text = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
    const name = `${text(345, 155) ? `${text(345, 155)}/` : ''}${text(0, 100)}`.replace(/^\.\//, '');
    const size = Number.parseInt(text(124, 12).trim() || '0', 8);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length)
      throw new Error('Malformed Debian data tar');
    const type = String.fromCharCode(header[156] || 48);
    if ((type === '0' || type === '\0') && name) {
      const normalized = path.posix.normalize(name);
      if (normalized.startsWith('../') || normalized === '..' || path.posix.isAbsolute(normalized))
        throw new Error(`Unsafe Debian archive path ${name}`);
      const target = path.join(destination, ...normalized.split('/'));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, tar.subarray(offset + 512, offset + 512 + size));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
}

/** Extract data.tar.zst from a Debian ar archive without invoking dpkg, apt or host tar. */
async function extractDeb(deb, destination) {
  const bytes = await readFile(deb);
  if (bytes.subarray(0, 8).toString('ascii') !== '!<arch>\n') throw new Error(`${path.basename(deb)} is not a Debian ar archive`);
  let offset = 8;
  let data = null;
  while (offset + 60 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 60);
    const name = header.subarray(0, 16).toString('ascii').trim().replace(/\/$/, '');
    const size = Number.parseInt(header.subarray(48, 58).toString('ascii').trim(), 10);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 60 + size > bytes.length)
      throw new Error(`${path.basename(deb)} has a malformed ar member`);
    const member = bytes.subarray(offset + 60, offset + 60 + size);
    if (name === 'data.tar.zst') data = zstdDecompressSync(member, { maxOutputLength: 256 * 1024 * 1024 });
    offset += 60 + size + (size & 1);
  }
  if (!data) throw new Error(`${path.basename(deb)} does not contain data.tar.zst`);
  await mkdir(destination, { recursive: true });
  await extractTar(data, destination);
}

async function firstFile(directory, pattern) {
  const names = (await readdir(directory)).filter(name => pattern.test(name)).sort();
  if (names.length !== 1) throw new Error(`Expected one ${pattern} in ${directory}, found ${names.join(', ') || '(none)'}`);
  return path.join(directory, names[0]);
}

async function stage(arch) {
  const assets = [...LINUX_DICTATION_RUNTIME.packages[arch], LINUX_DICTATION_RUNTIME.packages.model];
  const downloads = await Promise.all(assets.map(asset => verifiedDownload(asset, arch)));
  const extract = path.join(cacheRoot, `extract-${arch}`);
  const destination = path.join(stagingRoot, arch);
  await rm(extract, { recursive: true, force: true });
  await rm(destination, { recursive: true, force: true });
  await mkdir(extract, { recursive: true });
  for (let index = 0; index < downloads.length; index++)
    await extractDeb(downloads[index], path.join(extract, String(index)));

  const roots = await Promise.all(downloads.map((_, index) => Promise.resolve(path.join(extract, String(index)))));
  const packageRoot = (name) => roots[LINUX_DICTATION_RUNTIME.packages[arch].findIndex(asset => asset.name === name)];
  const modelRoot = roots.at(-1);
  const pythonRoot = path.join(destination, 'python');
  const libRoot = path.join(destination, 'lib');
  const licenseRoot = path.join(destination, 'licenses');
  await mkdir(pythonRoot, { recursive: true });
  await mkdir(libRoot, { recursive: true });
  await mkdir(licenseRoot, { recursive: true });

  const pythonSource = path.join(packageRoot('python3-pocketsphinx'), 'usr/lib/python3/dist-packages');
  const sphinxSource = path.join(packageRoot('python3-sphinxbase'), 'usr/lib/python3/dist-packages');
  for (const entry of await readdir(pythonSource)) if (entry.startsWith('pocketsphinx'))
    await cp(path.join(pythonSource, entry), path.join(pythonRoot, entry), { recursive: true });
  for (const entry of await readdir(sphinxSource)) if (entry.startsWith('sphinxbase'))
    await cp(path.join(sphinxSource, entry), path.join(pythonRoot, entry), { recursive: true });

  const multiarch = arch === 'x64' ? 'x86_64-linux-gnu' : 'aarch64-linux-gnu';
  const pocketLib = path.join(packageRoot('libpocketsphinx3'), 'usr/lib', multiarch);
  const sphinxLib = path.join(packageRoot('libsphinxbase3'), 'usr/lib', multiarch);
  await cp(await firstFile(pocketLib, /^libpocketsphinx\.so\.3\.0\.0$/), path.join(libRoot, 'libpocketsphinx.so.3'));
  await cp(await firstFile(sphinxLib, /^libsphinxbase\.so\.3\.0\.0$/), path.join(libRoot, 'libsphinxbase.so.3'));
  await cp(path.join(modelRoot, 'usr/share/pocketsphinx/model/en-us'), path.join(destination, 'model/en-us'), { recursive: true });

  await cp(path.join(packageRoot('libpocketsphinx3'), 'usr/share/doc/libpocketsphinx3/copyright'), path.join(licenseRoot, 'pocketsphinx.copyright'));
  await cp(path.join(packageRoot('libsphinxbase3'), 'usr/share/doc/libsphinxbase3/copyright'), path.join(licenseRoot, 'sphinxbase.copyright'));

  const manifest = {
    schema: 1,
    id: LINUX_DICTATION_RUNTIME.id,
    arch,
    pythonAbi: LINUX_DICTATION_RUNTIME.pythonAbi,
    packages: assets.map(({ name = 'pocketsphinx-en-us', version, file, sha256 }) => ({ name, version, file, sha256 }))
  };
  await writeFile(path.join(destination, 'runtime.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await rm(extract, { recursive: true, force: true });
  process.stdout.write(`Linux dictation runtime ${LINUX_DICTATION_RUNTIME.id} staged for ${arch}.\n`);
}

const { platform, arch } = parseTarget();
if (platform !== 'linux') process.stdout.write(`Linux dictation runtime skipped for ${platform}.\n`);
else stage(arch).catch(error => {
  process.stderr.write(`\nCould not prepare Linux dictation runtime: ${error.message}\n`);
  process.exitCode = 1;
});
