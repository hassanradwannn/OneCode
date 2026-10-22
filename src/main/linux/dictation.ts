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
  return {
    command,
    args: [helper, '--parent-pid', String(options.parentPid), '--stop-file', options.stopFile]
  };
}
