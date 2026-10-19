import path from 'node:path';

/**
 * Give Windows taskbar windows and Linux window managers the actual branded image.
 * Executable/shortcut metadata alone does not reliably supply a live window icon.
 * macOS retains its app-bundle icon.
 */
export function browserWindowIconPath(
  platform: NodeJS.Platform,
  packaged: boolean,
  resourcesPath: string
): string | undefined {
  if (!packaged || (platform !== 'linux' && platform !== 'win32')) return undefined;
  return path.join(resourcesPath, 'runtime-icon.png');
}

/** A distinct ICO avoids Explorer's cached executable icon when grouping/relaunching. */
export function windowsTaskbarIconPath(resourcesPath: string): string {
  return path.join(resourcesPath, 'runtime-icon.ico');
}
