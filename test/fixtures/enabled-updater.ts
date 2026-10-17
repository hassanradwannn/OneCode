/** Historical fixture name; production is now enabled for OneCode. These inherited
 * algorithm tests mock only the Windows download engine and read-only registry.
 * Real NSIS/blockmap/Range behavior is exercised by update-differential.test.ts. */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';

export async function loadEnabledUpdaterFixture() {
  const owner = await import('../../src/main/update.js');
  function resetUpdateForTests(): void {
    owner.resetUpdateForTests();
    owner.configureUpdateInstall(() => undefined);
    owner.configureUpdateForTests({
      target: async () => path.dirname(process.execPath), busy: async () => [],
      download: async (version, name) => {
        const response = await fetch(`https://github.com/hassanradwannn/OneCode/releases/download/v${version}/${name}`);
        if (!response.ok) throw new Error(`${name} answered ${response.status}`);
        const dir = path.join(app.getPath('userData'), 'engine-cache'); await mkdir(dir, { recursive: true });
        const file = path.join(dir, name); await writeFile(file, Buffer.from(await response.arrayBuffer())); return file;
      }
    });
  }
  return { ...owner, resetUpdateForTests,
    markInstallOnQuit: async (expectedVersion = owner.updateStatus().latest ?? '') => {
      try { return await owner.requestUpdateInstall(expectedVersion) === 'restarting'; } catch { return false; }
    },
    applyRequestedUpdate: async () => {
      if (owner.updateStatus().stage === 'ready' && !owner.updateStatus().installRequested)
        await owner.requestUpdateInstall(owner.updateStatus().latest!);
      await owner.applyStagedUpdate();
    }
  };
}
