import { spawn } from 'node:child_process';
import { copyFile, mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { hash } from '../../resources/updater/hotfix-contract.cjs';

/** The copy lives outside the directory NSIS replaces. Only the explicit quit owner calls it. */
export async function startWindowsUpdate(options: {
  version: string; file: string; digest: string; target: string; elevate: boolean;
  note: string; resources: string; executable: string; pid: number; log: string;
  hotfix?: string;
}): Promise<void> {
  const directory = path.dirname(options.note);
  await mkdir(directory, { recursive: true });
  const runtime = path.join(directory, 'bootstrap-node.exe');
  const helper = path.join(directory, 'windows-update-helper.cjs');
  await copyFile(path.join(options.resources, 'node', 'node.exe'), runtime);
  await copyFile(path.join(options.resources, 'updater', 'windows-update-helper.cjs'), helper);
  if (options.hotfix) await copyFile(path.join(options.resources, 'updater', 'hotfix-contract.cjs'), path.join(directory, 'hotfix-contract.cjs'));
  const fileVersion = options.version === '0.2.805' ? '0.2.8.5' : `${options.version}.0`;
  await writeFile(`${options.note}.tmp`, JSON.stringify({
    schema: options.hotfix ? 2 : 1, version: options.version, fileVersion, at: Date.now(), pid: options.pid,
    installer: options.file, digest: options.digest, target: options.target,
    executable: options.executable, elevate: options.elevate, log: options.log, status: 'pending',
    ...(options.hotfix ? { manifest: options.hotfix, manifestDigest: await hash(options.hotfix) } : {})
  }), { mode: 0o600 });
  await rename(`${options.note}.tmp`, options.note);
  const child = spawn(runtime, [helper, options.note], { detached: true, stdio: 'ignore', windowsHide: true });
  await new Promise<void>((resolve, reject) => { child.once('spawn', () => resolve()); child.once('error', reject); });
  child.unref();
}
