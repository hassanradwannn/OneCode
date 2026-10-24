/** One profile owner. Installation updates must never replace the user's data. */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { BUILD_CHANNEL, PRODUCT_LABEL } from '../shared/build-channel.js';

const MARKER = 'installation-profile.json';
const digest = (file: string): string => {
  const hash = createHash('sha256'), handle = fs.openSync(file, 'r'), block = Buffer.alloc(256 * 1024);
  try { for (;;) { const size = fs.readSync(handle, block); if (!size) break; hash.update(block.subarray(0, size)); } }
  finally { fs.closeSync(handle); }
  return hash.digest('hex');
};

export function installedProfileDirectory(executable: string, home = homedir()): string {
  // A sibling survives NSIS replacement/uninstall. Separate OS users and Beta.
  const user = createHash('sha256').update(path.resolve(home).toLowerCase()).digest('hex').slice(0, 16);
  return path.join(path.dirname(path.dirname(executable)), `${PRODUCT_LABEL} Data`, user);
}

function privateDirectory(directory: string): void {
  fs.mkdirSync(directory, { mode: 0o700 });
  if (process.platform !== 'win32') return;
  const system = process.env.SystemRoot || 'C:\\Windows';
  const user = execFileSync(path.join(system, 'System32', 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
  const sid = /S-1-5-\d+(?:-\d+)+/.exec(user)?.[0];
  if (!sid) throw new Error('Cannot establish the current user for the installation data folder');
  // Protect only this new directory; never alter source ACLs or security software.
  execFileSync(path.join(system, 'System32', 'icacls.exe'), [directory, '/inheritance:r', '/grant:r',
    `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F'], { windowsHide: true, stdio: 'pipe' });
}

/** Copy under the existing primary-instance lock, prove every regular file, then publish once.
 * Failed copies stay in their named staging folder; the original is never renamed or deleted. */
export function migrateInstalledProfile(source: string, destination: string, secure = privateDirectory): string {
  source = path.resolve(source); destination = path.resolve(destination);
  if (source === destination) return source;
  if (destination.startsWith(source + path.sep) || source.startsWith(destination + path.sep)) throw new Error('Profile migration paths overlap');
  const receipt = { schema: 1, channel: BUILD_CHANNEL, source, destination };
  for (let parent = destination; ; parent = path.dirname(parent)) {
    if (fs.existsSync(parent) && fs.lstatSync(parent).isSymbolicLink()) throw new Error('Installation data paths must not redirect');
    if (path.dirname(parent) === parent) break;
  }
  if (fs.existsSync(destination)) {
    const metadata = JSON.parse(fs.readFileSync(path.join(destination, MARKER), 'utf8'));
    if (metadata.schema !== 1 || metadata.channel !== BUILD_CHANNEL || metadata.source !== source || metadata.destination !== destination)
      throw new Error('The installation data folder belongs to another profile');
    return destination;
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const stage = `${destination}.migrating-${randomUUID()}`;
  secure(stage);
  let files = 0;
  const copy = (from: string, to: string): void => {
    const stat = fs.lstatSync(from);
    if (stat.isSymbolicLink()) throw new Error('Profile migration requires resolving an existing symbolic link first');
    if (stat.isDirectory()) {
      fs.mkdirSync(to, { recursive: true, mode: 0o700 });
      for (const name of fs.readdirSync(from)) {
        // Chromium process locks are not retained user data.
        if (from === source && ['updates', 'SingletonLock', 'SingletonSocket', 'SingletonCookie'].includes(name)) continue;
        copy(path.join(from, name), path.join(to, name));
      }
      fs.utimesSync(to, stat.atime, stat.mtime);
    } else if (stat.isFile()) {
      fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
      if (fs.statSync(to).size !== stat.size || digest(from) !== digest(to)) throw new Error('Profile copy verification failed');
      fs.utimesSync(to, stat.atime, stat.mtime); files++;
    } else throw new Error('Unsupported entry in the existing profile');
  };
  if (fs.existsSync(source)) copy(source, stage);
  fs.writeFileSync(path.join(stage, MARKER), JSON.stringify({ ...receipt, files, omittedCache: ['updates'], completedAt: Date.now() }), { flag: 'wx', mode: 0o600 });
  fs.renameSync(stage, destination);
  return destination;
}

interface ProfileOptions {
  packaged: boolean; platform: string; executable: string; current: string; legacy: string[]; argv: string[];
}
function usesLegacyDefault(options: ProfileOptions): boolean {
  return options.packaged && options.platform === 'win32' &&
      // The old helper must finish its exact-profile visible-window receipt first.
      !options.argv.includes('--updated') &&
      options.legacy.some(directory => path.resolve(directory).toLowerCase() === path.resolve(options.current).toLowerCase());
}
function destinations(options: ProfileOptions): string[] {
  const adjacent = installedProfileDirectory(options.executable);
  const fallback = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, `${PRODUCT_LABEL} Data`, path.basename(adjacent));
  return [adjacent, ...(fallback ? [fallback] : [])];
}
/** Reuse an already-published migration before choosing the single-instance namespace. */
export function existingInstalledProfile(options: ProfileOptions): string {
  if (!usesLegacyDefault(options)) return options.current;
  const destination = destinations(options).find(directory => fs.existsSync(directory));
  return destination ? migrateInstalledProfile(options.current, destination) : options.current;
}
export function prepareInstalledProfile(options: ProfileOptions): string {
  if (!usesLegacyDefault(options)) return options.current;
  const candidates = destinations(options);
  for (let index = 0; index < candidates.length; index++) {
    const destination = candidates[index]!;
    // Only an unwritable installation parent selects per-user Local data. Never
    // interpret a failed source read or copy as an empty profile or retry it elsewhere.
    const parent = path.dirname(destination), probe = path.join(parent, `.write-${randomUUID()}`);
    try {
      fs.mkdirSync(parent, { recursive: true });
      fs.writeFileSync(probe, '', { flag: 'wx', mode: 0o600 }); fs.unlinkSync(probe);
    } catch (error) {
      if (index + 1 < candidates.length && ['EACCES', 'EPERM', 'EROFS'].includes((error as NodeJS.ErrnoException).code ?? '')) continue;
      throw error;
    }
    return migrateInstalledProfile(options.current, destination);
  }
  throw new Error('No writable installation data folder');
}

/** Rebase only app-owned plugin runtime paths; transcripts and user workspace grants stay exact. */
export function relocatedPluginRecord<T extends { id: string; directory: string; launch: unknown; config: unknown }>(record: T, current: string): T {
  let receipt: { schema?: number; channel?: string; source?: string; destination?: string };
  try { receipt = JSON.parse(fs.readFileSync(path.join(current, MARKER), 'utf8')); }
  catch { return record; }
  if (receipt.schema !== 1 || receipt.channel !== BUILD_CHANNEL || receipt.destination !== path.resolve(current) ||
      typeof receipt.source !== 'string' || !path.isAbsolute(receipt.source) || !/^[a-f0-9-]{36}$/.test(record.id)) return record;
  const oldPlugin = path.join(receipt.source, 'plugins', record.id), newPlugin = path.join(current, 'plugins', record.id);
  if (typeof record.directory !== 'string' || !path.resolve(record.directory).startsWith(oldPlugin + path.sep)) return record;
  const relocate = (value: unknown): unknown => {
    if (typeof value === 'string' && path.isAbsolute(value)) {
      const relative = path.relative(oldPlugin, value);
      return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) ? path.join(newPlugin, relative) : value;
    }
    if (Array.isArray(value)) return value.map(relocate);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, relocate(entry)]));
    return value;
  };
  return { ...record, directory: relocate(record.directory), launch: relocate(record.launch), config: relocate(record.config) } as T;
}
