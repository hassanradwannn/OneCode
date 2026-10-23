import { app } from 'electron';
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

export type InstallationKind = 'windows' | 'appimage' | 'deb' | 'linux-unpacked' | 'macos' | 'development' | 'unsupported';
export type AppImageIdentity = Readonly<{ target: string; appDir: string; executable: string; resources: string; dev: number; ino: number; size: number; mtimeMs: number }>;

type InstallationObservation = { platform: string; kind: InstallationKind; appImage?: AppImageIdentity };
let readMountInfo = (): string => readFileSync('/proc/self/mountinfo', 'utf8');
/** Test seam for the kernel mount table; production always reads this process's mountinfo. */
export function setMountInfoReaderForTests(reader: (() => string) | null): void {
  readMountInfo = reader ?? (() => readFileSync('/proc/self/mountinfo', 'utf8'));
}

function isAppImageMount(appDir: string): boolean {
  const escaped = appDir.replace(/\\/g, '\\134').replace(/ /g, '\\040').replace(/\t/g, '\\011').replace(/\n/g, '\\012');
  return readMountInfo().split(/\r?\n/).some(line => {
    const fields = line.split(' '), separator = fields.indexOf('-');
    return fields[4] === escaped && separator >= 0 && /^fuse(?:\.|$)/.test(fields[separator + 1] ?? '');
  });
}

const observation = (): InstallationObservation | undefined => (globalThis as typeof globalThis & {
  __onecodeInstallation?: InstallationObservation;
}).__onecodeInstallation;

/** Revalidate the immutable bootstrap evidence against the still-mounted AppImage and target. */
export function currentAppImageIdentity(): AppImageIdentity | null {
  const observed = observation();
  if (observed?.platform !== 'linux' || observed.kind !== 'appimage' || !observed.appImage) return null;
  const identity = observed.appImage;
  try {
    const targetClaim = process.env.APPIMAGE?.trim(), appDirClaim = process.env.APPDIR?.trim();
    if (!targetClaim || !appDirClaim || !path.isAbsolute(targetClaim) || !path.isAbsolute(appDirClaim)) return null;
    const target = realpathSync(targetClaim), appDir = realpathSync(appDirClaim);
    const executable = realpathSync(process.execPath), resources = realpathSync(process.resourcesPath);
    if (target !== identity.target || appDir !== identity.appDir || executable !== identity.executable || resources !== identity.resources ||
        resources !== path.join(appDir, 'resources') || !isAppImageMount(appDir)) return null;
    const relative = path.relative(appDir, executable);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
    const targetPathStat = lstatSync(target);
    if (!targetPathStat.isFile() || targetPathStat.isSymbolicLink()) return null;
    const stat = statSync(target);
    if (stat.dev !== identity.dev || stat.ino !== identity.ino || stat.size !== identity.size || stat.mtimeMs !== identity.mtimeMs) return null;
    return identity;
  } catch { return null; }
}

/** The immutable bootstrap establishes package ownership before choosing a profile. */
export function installationKind(
  platform: NodeJS.Platform = process.platform,
  packaged = app.isPackaged,
  appImage: string | undefined = process.env.APPIMAGE
): InstallationKind {
  if (!packaged) return 'development';
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'macos';
  if (platform !== 'linux') return 'unsupported';
  // `appImage` is retained as an ignored compatibility parameter; the environment alone is not
  // evidence that this process is executing from that image.
  void appImage;
  const observed = observation();
  if (observed?.platform !== 'linux') return 'linux-unpacked';
  if (observed.kind === 'appimage') return currentAppImageIdentity() ? 'appimage' : 'linux-unpacked';
  return observed.kind === 'deb' ? 'deb' : 'linux-unpacked';
}
