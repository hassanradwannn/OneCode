import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import { expect, it } from 'vitest';

it('emits a matching one-architecture feed only for complete release artifacts', async () => {
  const { writeUpdateMetadata } = await import(pathToFileURL(path.resolve('scripts/write-update-metadata.mjs')).href);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'onecode-metadata-'));
  try {
    const bytes = Buffer.from('installer-fixture');
    await writeFile(path.join(dir, 'OneCode-Setup-x64.exe'), bytes);
    await expect(writeUpdateMetadata(dir, 'x64', '0.2.7')).rejects.toThrow();
    await writeFile(path.join(dir, 'OneCode-Setup-x64.exe.blockmap'), 'blockmap-fixture');
    const file = await writeUpdateMetadata(dir, 'x64', '0.2.7');
    expect(path.basename(file)).toBe('latest-x64.yml');
    expect(yaml.load(await readFile(file, 'utf8'))).toMatchObject({ version: '0.2.7', files: [{ url: 'OneCode-Setup-x64.exe',
      size: bytes.length, sha512: createHash('sha512').update(bytes).digest('base64') }] });
    await expect(writeUpdateMetadata(dir, 'arm64', '0.2.7')).rejects.toThrow();
    await expect(writeUpdateMetadata(dir, 'x64', '../foreign')).rejects.toThrow();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
