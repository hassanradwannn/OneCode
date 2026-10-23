/**
 * Immutable packaged entry point. Linux application hotfixes never rewrite the mounted
 * AppImage/DEB resources; this loader may select a previously verified sidecar application layer
 * whose runtime fingerprint still matches the complete base that is executing it.
 *
 * Keep this file self-contained apart from Node/Electron built-ins. Its packaged hash is part of
 * the Linux runtime receipt, so changing bootstrap semantics deliberately requires a new full base.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, lstatSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { app } from 'electron';

const PRODUCT_NAME = 'OneCode';
const APP_ID = 'io.onecode.desktop';
const VERSION = /^\d+\.\d+\.\d+$/;
const HEX = /^[a-f0-9]{64}$/;
const LAYER_DIR = /^[A-Za-z0-9._-]{1,120}$/;
type LinuxRuntime = { schema: 2; platform: 'linux'; arch: string; id: string; baseVersion: string };
type LayerFile = { path: string; size: number; sha256: string };
type ActiveLayer = { schema: 2; version: string; runtime: string; baseVersion: string; directory: string; files: LayerFile[] };
type AppImageIdentity = { target: string; appDir: string; executable: string; resources: string; dev: number; ino: number; size: number; mtimeMs: number };

/** APPIMAGE is only a claim; prove it matches the mounted runtime before granting update authority. */
function mountedAppImageIdentity(): AppImageIdentity | null {
  try {
    const claimed = process.env.APPIMAGE?.trim(), mounted = process.env.APPDIR?.trim();
    if (!claimed || !mounted || !path.isAbsolute(claimed) || !path.isAbsolute(mounted)) return null;
    const target = realpathSync(claimed), appDir = realpathSync(mounted);
    const executable = realpathSync(process.execPath), resources = realpathSync(process.resourcesPath);
    const inside = (root: string, file: string) => {
      const relative = path.relative(root, file);
      return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    };
    const escapedMount = appDir.replace(/\\/g, '\\134').replace(/ /g, '\\040').replace(/\t/g, '\\011').replace(/\n/g, '\\012');
    const mount = readFileSync('/proc/self/mountinfo', 'utf8').split(/\r?\n/).some(line => {
      const fields = line.split(' '), separator = fields.indexOf('-');
      return fields[4] === escapedMount && separator >= 0 && /^fuse(?:\.|$)/.test(fields[separator + 1] ?? '');
    });
    if (!mount || !inside(appDir, executable) || resources !== path.join(appDir, 'resources')) return null;
    const targetStat = lstatSync(target);
    if (!targetStat.isFile() || targetStat.isSymbolicLink()) return null;
    const stat = statSync(target);
    return { target, appDir, executable, resources, dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
  } catch { return null; }
}

/** No valid mounted AppImage means only that this is not one. Prove package ownership for DEB. */
function packagedLinuxKind(): { kind: 'appimage' | 'deb' | 'linux-unpacked'; appImage?: AppImageIdentity } {
  const appImage = mountedAppImageIdentity();
  if (appImage) return { kind: 'appimage', appImage };
  try {
    const executable = realpathSync(process.execPath);
    try {
      if (readFileSync('/var/lib/dpkg/info/onecode.list', 'utf8').split(/\r?\n/).includes(executable)) return { kind: 'deb' };
    } catch { /* Query the package database when the direct package inventory is absent. */ }
    const ownership = execFileSync('/usr/bin/dpkg-query', ['--search', executable], {
      encoding: 'utf8', timeout: 2_000, maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'ignore']
    });
    if (ownership.split(/\r?\n/).some(line => {
      const match = /^onecode(?::[a-z0-9-]+)?: (.+)$/.exec(line);
      return !!match && match[1] === executable;
    })) return { kind: 'deb' };
  } catch { /* An unowned directory build cannot use the production profile or updater. */ }
  return { kind: 'linux-unpacked' };
}
const linuxInstallation = app.isPackaged && process.platform === 'linux' ? packagedLinuxKind() : null;
const linuxKind = linuxInstallation?.kind ?? null;
Object.defineProperty(globalThis, '__onecodeInstallation', {
  value: Object.freeze({ platform: process.platform, kind: linuxKind, ...(linuxInstallation?.appImage ? { appImage: Object.freeze(linuxInstallation.appImage) } : {}) }), configurable: false, writable: false
});

const appDataDirectory = (): string => {
  const override = process.env.ONECODE_USER_DATA?.trim() || process.env.GEMINI_CODE_USER_DATA?.trim();
  if (override) return path.resolve(override);
  let commandLineProfile: string | null = null;
  for (let index = 0; index < process.argv.length; index++) {
    const argument = process.argv[index]!;
    if (argument.startsWith('--user-data-dir=')) commandLineProfile = argument.slice('--user-data-dir='.length);
    else if (argument === '--user-data-dir') {
      const value = process.argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error('The --user-data-dir argument requires an absolute path');
      commandLineProfile = value;
      index++;
    }
  }
  if (commandLineProfile !== null) {
    if (!commandLineProfile.trim() || !path.isAbsolute(commandLineProfile))
      throw new Error('The --user-data-dir argument requires an absolute path');
    return path.resolve(commandLineProfile);
  }
  const appData = app.getPath('appData');
  if (linuxKind === 'linux-unpacked') {
    const incarnation = createHash('sha256').update(path.resolve(process.execPath)).digest('hex').slice(0, 16);
    return path.join(appData, 'OneCode-QA', incarnation);
  }
  const current = path.join(appData, PRODUCT_NAME), legacy = path.join(appData, 'GeminiCode');
  return !existsSync(current) && existsSync(legacy) ? legacy : current;
};

app.setName(PRODUCT_NAME);
app.setAppUserModelId(app.isPackaged ? APP_ID : `${APP_ID}.development`);
app.commandLine.appendSwitch('force-renderer-accessibility');
app.setPath('userData', appDataDirectory());

const requireHere = createRequire(__filename);
const baseEntry = path.join(__dirname, 'index.js');

function hash(file: string): string { return createHash('sha256').update(readFileSync(file)).digest('hex'); }
function regularUnlinked(file: string): boolean {
  try { const stat = lstatSync(file); return stat.isFile() && !stat.isSymbolicLink(); } catch { return false; }
}
function directoryUnlinked(file: string): boolean {
  try { const stat = lstatSync(file); return stat.isDirectory() && !stat.isSymbolicLink(); } catch { return false; }
}
function diagnostic(message: string): void {
  try { appendFileSync(path.join(app.getPath('userData'), 'app.log'), `${new Date().toISOString()} warn linux application layer: ${message.slice(0, 500)}\n`); } catch { /* logging cannot block startup */ }
}
function safeRelative(name: unknown): name is string {
  return typeof name === 'string' && name.length < 240 && /^[A-Za-z0-9@_+./ -]+$/.test(name) &&
    name.split('/').every(part => part && part !== '.' && part !== '..' && !/[. ]$/.test(part));
}
function fileInside(root: string, relative: string): string | null {
  if (!safeRelative(relative)) return null;
  const resolvedRoot = path.resolve(root), file = path.resolve(root, ...relative.split('/'));
  if (!file.startsWith(resolvedRoot + path.sep)) return null;
  let cursor = file;
  while (cursor !== resolvedRoot) {
    let stat;
    try { stat = lstatSync(cursor); } catch { return null; }
    if (stat.isSymbolicLink()) return null;
    if (cursor === file ? !stat.isFile() : !stat.isDirectory()) return null;
    cursor = path.dirname(cursor);
  }
  return file;
}
function atomicJson(file: string, value: unknown): void {
  const temp = `${file}.tmp-${process.pid}`;
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  renameSync(temp, file);
}

function recoverFailedLayer(layers: string): void {
  const launching = path.join(layers, 'launching.json');
  if (!regularUnlinked(launching)) return;
  const active = path.join(layers, 'active.json'), rollback = path.join(layers, 'rollback.json');
  try {
    if (regularUnlinked(rollback)) {
      const prior = JSON.parse(readFileSync(rollback, 'utf8')) as { active?: unknown };
      if (prior && Object.hasOwn(prior, 'active') && prior.active !== null) atomicJson(active, prior.active);
      else rmSync(active, { force: true });
    } else rmSync(active, { force: true });
    diagnostic('previous application layer did not reach a ready window; restored the prior layer');
  } catch {
    rmSync(active, { force: true });
    diagnostic('previous application layer failed and its rollback receipt was invalid; using bundled application');
  } finally {
    rmSync(launching, { force: true });
    rmSync(rollback, { force: true });
  }
}

function activeLinuxLayer(): { root: string; appAsar: string; version: string; runtime: string } | null {
  if (!app.isPackaged || process.platform !== 'linux') return null;
  const runtimeFile = path.join(process.resourcesPath, 'updater', 'runtime.json');
  const layers = path.join(app.getPath('userData'), 'application-layers');
  if (!existsSync(layers)) return null;
  if (!directoryUnlinked(layers)) { diagnostic('application layer owner path is redirected; using bundled application'); return null; }
  recoverFailedLayer(layers);
  const activeFile = path.join(layers, 'active.json');
  if (!regularUnlinked(runtimeFile) || !regularUnlinked(activeFile)) return null;
  let runtime: LinuxRuntime, active: ActiveLayer;
  try { runtime = JSON.parse(readFileSync(runtimeFile, 'utf8')) as LinuxRuntime; active = JSON.parse(readFileSync(activeFile, 'utf8')) as ActiveLayer; }
  catch { diagnostic('receipt is unreadable; using bundled application'); return null; }
  if (runtime.schema !== 2 || runtime.platform !== 'linux' || !HEX.test(runtime.id) || !VERSION.test(runtime.baseVersion) ||
      active.schema !== 2 || !VERSION.test(active.version) || active.runtime !== runtime.id || active.baseVersion !== runtime.baseVersion ||
      !LAYER_DIR.test(active.directory) || !Array.isArray(active.files) || active.files.length < 1 || active.files.length > 512) {
    diagnostic('receipt does not match this complete base; using bundled application'); return null;
  }
  const root = path.join(layers, active.directory);
  if (!directoryUnlinked(root)) { diagnostic('layer path is missing or redirected; using bundled application'); return null; }
  const seen = new Set<string>(); let total = 0; let appAsar: string | null = null;
  for (const entry of active.files) {
    if (!entry || !safeRelative(entry.path) || !HEX.test(entry.sha256) || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > 192 * 1024 * 1024) {
      diagnostic('layer inventory is invalid; using bundled application'); return null;
    }
    const key = entry.path.toLowerCase();
    if (seen.has(key)) { diagnostic('layer inventory contains duplicate paths; using bundled application'); return null; }
    seen.add(key); total += entry.size;
    if (total > 256 * 1024 * 1024) { diagnostic('layer inventory is too large; using bundled application'); return null; }
    const file = fileInside(root, entry.path);
    if (!file) { diagnostic('layer resource path is missing or redirected; using bundled application'); return null; }
    const stat = lstatSync(file);
    if (stat.size !== entry.size || hash(file) !== entry.sha256) { diagnostic('layer resource changed after activation; using bundled application'); return null; }
    if (entry.path === 'app.asar') appAsar = file;
  }
  if (!appAsar) { diagnostic('layer inventory has no application archive; using bundled application'); return null; }
  atomicJson(path.join(layers, 'launching.json'), { schema: 1, version: active.version, runtime: active.runtime, directory: active.directory, at: Date.now() });
  return { root, appAsar, version: active.version, runtime: active.runtime };
}

const layer = activeLinuxLayer();
if (layer) {
  (globalThis as typeof globalThis & { __onecodeApplicationLayer?: typeof layer }).__onecodeApplicationLayer = layer;
  requireHere(path.join(layer.appAsar, 'out', 'main', 'index.js'));
} else {
  requireHere(baseEntry);
}
