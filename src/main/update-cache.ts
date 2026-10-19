import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat, rm, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
const MAP = 'current.blockmap', PAIR = 'onecode-differential-cache.json';
async function digest(file: string, algorithm: string): Promise<string> {
  const hash = createHash(algorithm); for await (const bytes of createReadStream(file)) hash.update(bytes); return hash.digest('base64');
}
async function readMap(directory: string): Promise<Buffer> {
  const file = path.join(directory, MAP); if ((await stat(file)).size > 2 * 1024 * 1024) throw Error('Oversized block map'); return readFile(file);
}
/** Advisory download cache only. Installation still requires the release's verified digest. */
export async function repairDifferentialCache(directory: string, installerName = 'installer.exe'): Promise<boolean> {
  const mapFile = path.join(directory, MAP), installer = path.join(directory, installerName);
  try {
    const bytes = await readMap(directory), map = JSON.parse(gunzipSync(bytes, { maxOutputLength: 16 * 1024 * 1024 }).toString());
    const size = (await stat(installer)).size;
    if (map.version !== '2' || !Array.isArray(map.files) || !map.files.length) throw Error('Invalid block map');
    let end = 0;
    for (const file of map.files) {
      if (!Number.isSafeInteger(file.offset) || file.offset !== end || !Array.isArray(file.sizes) || !file.sizes.length || file.sizes.length !== file.checksums?.length) throw Error('Invalid block map extent');
      for (const value of file.sizes) { if (!Number.isSafeInteger(value) || value <= 0) throw Error('Invalid block'); end += value; }
    }
    if (end !== size) throw Error('Cache size mismatch');
    let pair;
    try { const file = path.join(directory, PAIR); if ((await stat(file)).size > 512) throw Error('Invalid pair'); pair = JSON.parse(await readFile(file, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (pair && (pair.schema !== 1 || pair.installer !== await digest(installer, 'sha512') || pair.blockmap !== createHash('sha256').update(bytes).digest('base64'))) throw Error('Cache pair changed');
    return false;
  } catch (error) {
    // Missing maps are already fetched by electron-updater. A mismatched map must
    // also be fetched, rather than spending a whole patch transfer on bad offsets.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    await rm(mapFile, { force: true }); await rm(path.join(directory, PAIR), { force: true }); return true;
  }
}
export async function rememberDifferentialCache(directory: string, installerSha512: string): Promise<void> {
  const bytes = await readMap(directory), pending = await readMap(path.join(directory, 'pending'));
  if (!bytes.equals(pending)) throw Error('Completed download block map is not current');
  const file = path.join(directory, PAIR);
  await writeFile(file + '.tmp', JSON.stringify({ schema: 1, installer: installerSha512, blockmap: createHash('sha256').update(bytes).digest('base64') }));
  await rename(file + '.tmp', file);
}
