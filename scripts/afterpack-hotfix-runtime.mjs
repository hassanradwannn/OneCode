import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import contract from '../resources/updater/hotfix-contract.cjs';
import { getCurrentFuseWire, FuseV1Options } from '@electron/fuses';
import { extractFile } from '@electron/asar';
export default async function afterPack(context) {
  if (context.electronPlatformName !== 'win32' && context.electronPlatformName !== 'linux') return;
  const resources = path.join(context.appOutDir, 'resources');
  const arch = context.arch === 1 ? 'x64' : context.arch === 3 ? 'arm64' : null;
  if (!arch) throw Error('Unsupported hotfix architecture');
  const electron = context.packager.info.framework.version;
  if(!/^\d+\.\d+\.\d+$/.test(context.packager.appInfo.version)) throw Error('The installed base must have an exact release version');
  let runtime;
  if (context.electronPlatformName === 'win32') {
    const wire = await getCurrentFuseWire(path.join(context.appOutDir, 'OneCode.exe'));
    if (wire[FuseV1Options.EnableEmbeddedAsarIntegrityValidation] !== '0'.charCodeAt(0))
      throw Error('This executable requires an embedded ASAR seal; application hotfix replacement is unavailable');
    const files = await contract.inventory(resources, name => !contract.mutable(name, 'win32') && name !== 'updater/runtime.json' && !name.endsWith('.d.cts'));
    runtime = { schema: 1, platform: 'win32', arch, electron, files, baseVersion: context.packager.appInfo.version, id: contract.runtimeId(arch, files, electron) };
  } else {
    const files = await contract.inventory(resources, name => !contract.mutable(name, 'linux') && name !== 'updater/runtime.json' && !name.endsWith('.d.cts'));
    const loader = createHash('sha256').update(extractFile(path.join(resources, 'app.asar'), 'out/main/bootstrap.js')).digest('hex');
    runtime = { schema: 2, platform: 'linux', arch, electron, loader, files, baseVersion: context.packager.appInfo.version,
      id: contract.runtimeId('linux', arch, files, electron, loader) };
  }
  contract.runtime(runtime);
  await fs.writeFile(path.join(resources, 'updater/runtime.json'), JSON.stringify(runtime));
}
