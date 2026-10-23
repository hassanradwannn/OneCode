import fs from 'node:fs/promises';
import path from 'node:path';
import { extensionStamp, STAMP_FILE } from './write-extension-stamp.mjs';

/** Transform the packaged copy only. Stable and Beta must discover different bridge owners. */
export async function prepareChannelExtension(directory, channel) {
  if (channel === 'stable') return;
  if (channel !== 'beta') throw new Error('Unknown Companion build channel');
  const ports = [48765, 48766, 48767, 48768, 48769, 49765, 49766, 49767, 49768, 49769, 59765, 59766, 59767, 59768, 59769];
  const manifestFile = path.join(directory, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  manifest.name = 'OneCode Beta Companion';
  manifest.version_name = `${manifest.version} Beta`;
  manifest.action.default_title = 'OneCode Beta Companion';
  manifest.host_permissions = [...manifest.host_permissions.filter(value => !/^http:\/\/127\.0\.0\.1:\d+\/\*$/.test(value)),
    ...ports.map(port => `http://127.0.0.1:${port}/*`)];
  await fs.writeFile(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
  const backgroundFile = path.join(directory, 'background.js');
  const source = await fs.readFile(backgroundFile, 'utf8');
  const pattern = /^const PORTS = \[[0-9, ]+\];$/m;
  if (!pattern.test(source)) throw new Error('Companion bridge declaration is missing');
  await fs.writeFile(backgroundFile, source.replace(pattern, `const PORTS = [${ports.join(', ')}];`)
    .replace("const BACKGROUND_GROUP_TITLE = 'OneCode';", "const BACKGROUND_GROUP_TITLE = 'OneCode Beta';"));
  await fs.writeFile(path.join(directory, STAMP_FILE), extensionStamp(directory) + '\n');
}
