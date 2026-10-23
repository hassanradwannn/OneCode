import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import contract from '../resources/updater/hotfix-contract.cjs';
import { getCurrentFuseWire, FuseV1Options } from '@electron/fuses';
import { extractFile } from '@electron/asar';
import { prepareChannelExtension } from './prepare-channel-extension.mjs';
import { getAppUpdatePublishConfiguration } from 'app-builder-lib/out/publish/PublishManager.js';
import { serializeToYaml } from 'builder-util';
const BUILD_CHANNEL = process.env.ONECODE_BUILD_CHANNEL === 'beta' ? 'beta' : 'stable';
export default async function afterPack(context) {
  if (context.electronPlatformName !== 'win32' && context.electronPlatformName !== 'linux') return;
  const resources = path.join(context.appOutDir, 'resources');
  await prepareChannelExtension(path.join(resources, 'extension'), BUILD_CHANNEL);
  if (BUILD_CHANNEL === 'beta') {
    // PublishManager runs after this hook on Linux. Use its exact configuration and
    // serializer so the later generated file cannot invalidate the native inventory.
    const feed = await getAppUpdatePublishConfiguration(context.packager, null, context.arch, false);
    if (feed?.provider !== 'github' || feed.owner !== 'hassanradwannn' || feed.repo !== 'OneCode' ||
        feed.updaterCacheDirName !== 'onecode-beta-updater' ||
        Object.keys(feed).some(key => !['provider', 'owner', 'repo', 'updaterCacheDirName'].includes(key)))
      throw Error('Unexpected Beta updater publication identity');
    const betaFeed = serializeToYaml(feed);
    await fs.writeFile(path.join(resources, 'app-update.yml'), betaFeed);
    const nestedFeed = path.join(resources, 'updater', 'app-update.yml');
    if (await fs.stat(nestedFeed).then(() => true, () => false)) await fs.writeFile(nestedFeed, betaFeed);
  }
  const arch = context.arch === 1 ? 'x64' : context.arch === 3 ? 'arm64' : null;
  if (!arch) throw Error('Unsupported hotfix architecture');
  const electron = context.packager.info.framework.version;
  if(!/^\d+\.\d+\.\d+$/.test(context.packager.appInfo.version)) throw Error('The installed base must have an exact release version');
  let runtime;
  if (context.electronPlatformName === 'win32') {
    const executable = BUILD_CHANNEL === 'beta' ? 'onecode-beta.exe' : 'OneCode.exe';
    const wire = await getCurrentFuseWire(path.join(context.appOutDir, executable));
    if (wire[FuseV1Options.EnableEmbeddedAsarIntegrityValidation] !== '0'.charCodeAt(0))
      throw Error('This executable requires an embedded ASAR seal; application hotfix replacement is unavailable');
    const files = await contract.inventory(resources, name => !contract.mutable(name, 'win32') && name !== 'updater/runtime.json' && !name.endsWith('.d.cts'));
    runtime = { schema: 1, platform: 'win32', arch, electron, files, baseVersion: context.packager.appInfo.version,
      ...(BUILD_CHANNEL === 'beta' ? { channel: BUILD_CHANNEL } : {}),
      id: BUILD_CHANNEL === 'beta' ? contract.runtimeId('win32', arch, files, electron, undefined, BUILD_CHANNEL) : contract.runtimeId(arch, files, electron) };
  } else {
    const files = await contract.inventory(resources, name => !contract.mutable(name, 'linux') && name !== 'updater/runtime.json' && !name.endsWith('.d.cts'));
    const loader = createHash('sha256').update(extractFile(path.join(resources, 'app.asar'), 'out/main/bootstrap.js')).digest('hex');
    runtime = { schema: 2, platform: 'linux', arch, electron, loader, files, baseVersion: context.packager.appInfo.version,
      ...(BUILD_CHANNEL === 'beta' ? { channel: BUILD_CHANNEL } : {}),
      id: contract.runtimeId('linux', arch, files, electron, loader, BUILD_CHANNEL) };
  }
  contract.runtime(runtime);
  await fs.writeFile(path.join(resources, 'updater/runtime.json'), JSON.stringify(runtime));
}
