import fs from 'node:fs/promises';
import path from 'node:path';
import contract from '../resources/updater/hotfix-contract.cjs';
import { getCurrentFuseWire, FuseV1Options } from '@electron/fuses';
export default async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const resources = path.join(context.appOutDir, 'resources');
  const wire = await getCurrentFuseWire(path.join(context.appOutDir, 'OneCode.exe'));
  if (wire[FuseV1Options.EnableEmbeddedAsarIntegrityValidation] !== '0'.charCodeAt(0))
    throw Error('This executable requires an embedded ASAR seal; application hotfix replacement is unavailable');
  const arch = context.arch === 1 ? 'x64' : context.arch === 3 ? 'arm64' : null;
  if (!arch) throw Error('Unsupported Windows hotfix architecture');
  const files = await contract.inventory(resources, name => !contract.mutable(name) && name !== 'updater/runtime.json' && !name.endsWith('.d.cts'));
  const electron = context.packager.info.framework.version;
  if(!/^\d+\.\d+\.\d+$/.test(context.packager.appInfo.version)) throw Error('The installed base must have an exact release version');
  const runtime = { schema: 1, platform: 'win32', arch, electron, files, baseVersion: context.packager.appInfo.version, id: contract.runtimeId(arch, files, electron) };
  contract.runtime(runtime);
  await fs.writeFile(path.join(resources, 'updater/runtime.json'), JSON.stringify(runtime));
}
