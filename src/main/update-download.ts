/** Download engine only. The existing update owner verifies and installs its result. */
import { APP_VERSION } from './version.js';
import { isNewer } from '../shared/types.js';
import { CancellationToken, NsisUpdater, type UpdateInfo } from 'electron-updater';

export const UPDATE_REPOSITORY = 'hassanradwannn/OneCode';
export const windowsUpdateChannel = (arch: string): string => `latest-${arch}`;

export function configureWindowsDownloadEngine(updater: NsisUpdater): void {
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.allowDowngrade = false;
  updater.allowPrerelease = false;
  updater.disableDifferentialDownload = false;
  updater.disableWebInstaller = true;
}

export function validateWindowsUpdate(info: UpdateInfo, version: string, name: string): void {
  const expected = `https://github.com/${UPDATE_REPOSITORY}/releases/download/v${version}/${name}`;
  if (info.version !== version || info.files?.length !== 1 || ('packages' in info && info.packages) ||
      !info.files.every(file => (file.url === name || file.url === expected) &&
        /^[A-Za-z0-9+/]{86}==$/.test(file.sha512) && Number.isSafeInteger(file.size) && file.size! > 0)) {
    throw new Error('The OneCode update metadata does not match this release and architecture');
  }
}

export async function downloadWindowsUpdate(version: string, name: string,
  progress: (percent: number) => void): Promise<string> {
  const updater = new NsisUpdater({ provider: 'github', owner: 'hassanradwannn', repo: 'OneCode',
    channel: windowsUpdateChannel(process.arch) });
  // This engine must never own shutdown or install. In particular its normal-quit hook is off.
  configureWindowsDownloadEngine(updater);
  if (!isNewer(version, APP_VERSION)) throw new Error('Refusing an older OneCode release');
  // The update owner compares display releases, including shipped compatibility tags.
  // Permit the downloader's numeric downgrade only after that forward-version check.
  updater.allowDowngrade = true;
  updater.logger = null;
  updater.on('error', () => undefined); // rejection is reported once by the update owner
  const cancellation = new CancellationToken();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      updater.checkForUpdates(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Checking OneCode update metadata timed out')), 15000); })
    ]);
    if (!result) throw new Error('OneCode update metadata is unavailable');
    validateWindowsUpdate(result.updateInfo, version, name);
    clearTimeout(timer);
    timer = setTimeout(() => cancellation.cancel(), 60000);
    updater.on('download-progress', value => {
      timer?.refresh();
      progress(Math.max(0, Math.min(100, Math.round(value.percent))));
    });
    const files = await updater.downloadUpdate(cancellation);
    if (files.length !== 1 || !files[0]) throw new Error('OneCode did not download one complete installer');
    return files[0];
  } finally {
    clearTimeout(timer);
    updater.removeAllListeners();
    // A late failed check may still emit error after the bounded caller has returned.
    updater.on('error', () => undefined);
  }
}
