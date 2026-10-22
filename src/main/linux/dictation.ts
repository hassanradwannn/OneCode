import fs from 'node:fs';
import path from 'node:path';

export interface LinuxDictationLaunch {
  command: string;
  args: string[];
}

export function linuxDictationLaunch(options: {
  packaged: boolean;
  resourcesPath: string;
  appPath: string;
  parentPid: number;
  stopFile: string;
  python?: string;
  arch?: string;
}): LinuxDictationLaunch {
  const helper = options.packaged
    ? path.join(options.resourcesPath, 'linux', 'dictation.py')
    : path.join(options.appPath, 'linux', 'dictation.py');
  try {
    if (!path.isAbsolute(helper) || !fs.statSync(helper).isFile()) throw new Error('missing');
  } catch {
    throw new Error('Linux dictation helper is missing. Reinstall OneCode.');
  }
  const command = options.python ?? '/usr/bin/python3';
  try {
    if (!path.isAbsolute(command) || !fs.statSync(command).isFile()) throw new Error('missing');
  } catch {
    throw new Error('Python 3 is required for Linux dictation.');
  }
  const runtime = options.packaged
    ? path.join(options.resourcesPath, 'linux', 'runtime')
    : path.join(options.appPath, 'resources', 'packaging', 'dictation', 'linux', options.arch ?? process.arch);
  let hasRuntime = false;
  try { hasRuntime = fs.statSync(path.join(runtime, 'runtime.json')).isFile(); } catch { /* source checkout may use system packages */ }
  if (options.packaged && !hasRuntime) throw new Error('Bundled Linux dictation runtime is missing. Reinstall OneCode.');
  const args = [helper, '--parent-pid', String(options.parentPid), '--stop-file', options.stopFile];
  if (hasRuntime) args.push('--runtime-root', runtime);
  return {
    command,
    args
  };
}
