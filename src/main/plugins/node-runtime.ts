/** The app-private official Windows Node/npm bundle; never changes the system installation. */
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export interface BundledNodeRuntime { directory: string; node: string; npm: string; npx: string; version: string }
export function bundledNodeRuntime(options: { resourcesPath?: string; platform?: NodeJS.Platform; arch?: string } = {}): BundledNodeRuntime | null {
  const platform = options.platform ?? process.platform, arch = options.arch ?? process.arch;
  const resources = options.resourcesPath ?? process.resourcesPath;
  if (platform !== 'win32' || !resources || !path.isAbsolute(resources) || !['x64', 'arm64'].includes(arch)) return null;
  const directory = path.join(resources, 'node');
  try {
    const metadata = JSON.parse(readFileSync(path.join(directory, 'runtime.json'), 'utf8'));
    if (metadata.platform !== platform || metadata.arch !== arch || !/^v24\.\d+\.\d+$/.test(metadata.version) ||
      !/^[a-f0-9]{64}$/.test(metadata.sha256) || metadata.source !== `https://nodejs.org/dist/${metadata.version}/node-${metadata.version}-win-${arch}.zip`) return null;
    const node = path.join(directory, 'node.exe'), npm = path.join(directory, 'node_modules/npm/bin/npm-cli.js'), npx = path.join(directory, 'node_modules/npm/bin/npx-cli.js');
    if (![node, npm, npx, path.join(directory, 'LICENSE'), path.join(directory, 'node_modules/npm/LICENSE')].every(file => statSync(file).isFile())) return null;
    return { directory, node, npm, npx, version: metadata.version };
  } catch { return null; }
}
