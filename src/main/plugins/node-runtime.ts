/** App-private official Node/npm bundle used by packaged plugin installs; never changes the system installation. */
import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { chmod, cp, mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';

export interface BundledNodeRuntime { directory: string; node: string; npm: string; npx: string; version: string }

function expectedSource(version: string, platform: NodeJS.Platform, arch: string): string | null {
  if (platform === 'win32') return `https://nodejs.org/dist/${version}/node-${version}-win-${arch}.zip`;
  if (platform === 'linux') return `https://nodejs.org/dist/${version}/node-${version}-linux-${arch}.tar.xz`;
  return null;
}

export function bundledNodeRuntime(options: { resourcesPath?: string; platform?: NodeJS.Platform; arch?: string } = {}): BundledNodeRuntime | null {
  const platform = options.platform ?? process.platform, arch = options.arch ?? process.arch;
  const resources = options.resourcesPath ?? process.resourcesPath;
  if ((platform !== 'win32' && platform !== 'linux') || !resources || !path.isAbsolute(resources) || !['x64', 'arm64'].includes(arch)) return null;
  const directory = path.join(resources, 'node');
  try {
    const metadata = JSON.parse(readFileSync(path.join(directory, 'runtime.json'), 'utf8'));
    const source = expectedSource(metadata.version, platform, arch);
    if (metadata.platform !== platform || metadata.arch !== arch || !/^v24\.\d+\.\d+$/.test(metadata.version) ||
      !/^[a-f0-9]{64}$/.test(metadata.sha256) || !source || metadata.source !== source) return null;
    const node = platform === 'win32' ? path.join(directory, 'node.exe') : path.join(directory, 'bin/node');
    const npm = platform === 'win32' ? path.join(directory, 'node_modules/npm/bin/npm-cli.js') : path.join(directory, 'lib/node_modules/npm/bin/npm-cli.js');
    const npx = platform === 'win32' ? path.join(directory, 'node_modules/npm/bin/npx-cli.js') : path.join(directory, 'lib/node_modules/npm/bin/npx-cli.js');
    const npmLicense = platform === 'win32' ? path.join(directory, 'node_modules/npm/LICENSE') : path.join(directory, 'lib/node_modules/npm/LICENSE');
    if (![node, npm, npx, path.join(directory, 'LICENSE'), npmLicense].every(file => statSync(file).isFile())) return null;
    return { directory, node, npm, npx, version: metadata.version };
  } catch { return null; }
}

/**
 * AppImage resources live under a per-launch /tmp mount. An installed npm plugin must not persist
 * that mount path as its Node command, so Linux copies the verified packaged runtime once into the
 * stable plugins root and records that path instead. Windows installations already have a stable
 * resources directory and use the packaged runtime in place.
 */
export async function stablePluginNodeRuntime(
  pluginGeneration: string,
  options: { resourcesPath?: string; platform?: NodeJS.Platform; arch?: string } = {}
): Promise<BundledNodeRuntime | null> {
  const platform = options.platform ?? process.platform, arch = options.arch ?? process.arch;
  const source = bundledNodeRuntime({ ...options, platform, arch });
  if (!source || platform !== 'linux') return source;

  const generation = path.resolve(pluginGeneration);
  const pluginRoot = path.dirname(path.dirname(generation));
  const targetResources = path.join(pluginRoot, '.runtime', source.version, `${platform}-${arch}`);
  const existing = bundledNodeRuntime({ resourcesPath: targetResources, platform, arch });
  if (existing) return existing;

  await mkdir(path.dirname(targetResources), { recursive: true });
  const stage = `${targetResources}.stage-${process.pid}-${randomUUID()}`;
  await mkdir(stage, { recursive: false });
  try {
    await cp(source.directory, path.join(stage, 'node'), { recursive: true });
    await chmod(path.join(stage, 'node/bin/node'), 0o755);
    try {
      await rename(stage, targetResources);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error;
    }
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
  const runtime = bundledNodeRuntime({ resourcesPath: targetResources, platform, arch });
  if (!runtime) throw new Error('The private Linux Node.js plugin runtime could not be materialized safely.');
  return runtime;
}
