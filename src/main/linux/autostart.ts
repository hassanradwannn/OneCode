import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BUILD_CHANNEL, PRODUCT_LABEL } from '../../shared/build-channel.js';

const AUTOSTART_FILE = `${BUILD_CHANNEL === 'beta' ? 'io.onecode.desktop.beta' : 'io.onecode.desktop'}.desktop`;

function desktopExecArg(value: string): string {
  if (/\r|\n|\0/.test(value)) throw new Error('Linux startup executable contains an invalid character');
  // Desktop Entry Exec uses percent tokens even inside quotes. Double literal percents and
  // quote the characters the specification treats specially inside a quoted argument.
  const escaped = value
    .replaceAll('%', '%%')
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('$', '\\$')
    .replaceAll('`', '\\`');
  return `"${escaped}"`;
}

export function linuxAutostartPath(
  env: NodeJS.ProcessEnv = process.env,
  home = env.HOME ?? os.homedir()
): string {
  const configHome = env.XDG_CONFIG_HOME && path.posix.isAbsolute(env.XDG_CONFIG_HOME)
    ? env.XDG_CONFIG_HOME
    : path.posix.join(home, '.config');
  return path.posix.join(configHome, 'autostart', AUTOSTART_FILE);
}

export function linuxStartupExecutable(
  executable = process.execPath,
  appImage = process.env.APPIMAGE
): string {
  // process.execPath points inside /tmp/.mount_* for AppImage launches. APPIMAGE is the stable
  // file the user actually started and is also the target the updater replaces.
  if (appImage && path.posix.isAbsolute(appImage)) return appImage;
  if (!path.posix.isAbsolute(executable)) throw new Error('Linux startup executable must be absolute');
  return executable;
}

export function linuxAutostartContents(executable: string): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    `Name=${PRODUCT_LABEL}`,
    `Comment=Start ${PRODUCT_LABEL} in the background`,
    `Exec=${desktopExecArg(executable)} --background`,
    'Terminal=false',
    'StartupNotify=false',
    'X-GNOME-Autostart-enabled=true',
    ''
  ].join('\n');
}

export function applyLinuxLoginStartup(
  enabled: boolean,
  options: { env?: NodeJS.ProcessEnv; home?: string; executable?: string; appImage?: string } = {}
): void {
  const env = options.env ?? process.env;
  const target = linuxAutostartPath(env, options.home ?? env.HOME ?? os.homedir());
  if (!enabled) {
    fs.rmSync(target, { force: true });
    return;
  }
  const executable = linuxStartupExecutable(options.executable ?? process.execPath,
    options.appImage ?? env.APPIMAGE);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, linuxAutostartContents(executable), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
