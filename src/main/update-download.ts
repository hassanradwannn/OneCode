/** Download engine only. The existing update owner verifies and installs its result. */
import { APP_VERSION } from './version.js';
import { isNewer } from '../shared/types.js';
import { CancellationToken, NsisUpdater, type UpdateInfo, type ResolvedUpdateFileInfo, type Provider } from 'electron-updater';

import type { DownloadUpdateOptions } from 'electron-updater/out/AppUpdater.js';
import { repairDifferentialCache, rememberDifferentialCache } from './update-cache.js';
import { logWarn } from './logger.js';

export class ConsistentNsisUpdater extends NsisUpdater {
  cacheNotice: (message: string) => void = () => undefined;
  protected override async differentialDownloadInstaller(fileInfo: ResolvedUpdateFileInfo, options: DownloadUpdateOptions, destination: string, provider: Provider<UpdateInfo>, installerName: string): Promise<boolean> {
    try {
      if (this.downloadedUpdateHelper && await repairDifferentialCache(this.downloadedUpdateHelper.cacheDir, installerName))
        this.cacheNotice('update download: cached installer and block map differ; fetching the matching published block map');
    } catch {
      this.cacheNotice('update download: differential cache could not be checked; using the full installer'); return true;
    }
    return super.differentialDownloadInstaller(fileInfo, options, destination, provider, installerName);
  }
  async rememberCache(sha512: string): Promise<void> {
    if (this.downloadedUpdateHelper) try { await rememberDifferentialCache(this.downloadedUpdateHelper.cacheDir, sha512); }
    catch { this.cacheNotice('update download: cache pairing could not be saved; the next update will check it again'); }
  }
}

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
  const updater = new ConsistentNsisUpdater({ provider: 'generic', url: `https://github.com/${UPDATE_REPOSITORY}/releases/download/v${version}/`,
    channel: windowsUpdateChannel(process.arch) });
  // This engine must never own shutdown or install. In particular its normal-quit hook is off.
  configureWindowsDownloadEngine(updater);
  if (!isNewer(version, APP_VERSION)) throw new Error('Refusing an older OneCode release');
  // The update owner compares display releases, including shipped compatibility tags.
  // Permit the downloader's numeric downgrade only after that forward-version check.
  updater.allowDowngrade = true;
  updater.cacheNotice = logWarn;
  const diagnostic = (message: unknown) => {
    if (!String(message).includes('Cannot download differentially')) return;
    const reason = /checksum|digest/i.test(String(message)) ? 'patch verification failed' : /range|206/i.test(String(message)) ? 'range transfer failed' : 'differential transfer failed';
    logWarn(`update download: ${reason}; using the full installer`);
  };
  // Do not retain signed asset URLs or upstream request dumps in diagnostics.
  updater.logger = { info: () => undefined, warn: diagnostic, error: diagnostic };
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
    await updater.rememberCache(result.updateInfo.files[0]!.sha512);
    return files[0];
  } finally {
    clearTimeout(timer);
    updater.removeAllListeners();
    // A late failed check may still emit error after the bounded caller has returned.
    updater.on('error', () => undefined);
  }
}
