import path from 'node:path';
import type { ShortcutDetails } from 'electron';
import { APP_ID, PRODUCT_NAME } from './app-identity.js';
import { windowsTaskbarIconPath } from './window-icon.js';
type ShortcutOwner = { readShortcutLink(file: string): ShortcutDetails; writeShortcutLink(file: string, operation: 'update', details: Partial<ShortcutDetails>): boolean };
/** Repair only links that already target this exact executable. Never adopt another installation. */
export function repairWindowsShortcuts(shell: ShortcutOwner, paths: { appData: string; desktop: string; executable: string; resources: string }): void {
  const menu = path.join(paths.appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${PRODUCT_NAME}.lnk`);
  for (const file of [menu, path.join(paths.desktop, `${PRODUCT_NAME}.lnk`)]) {
    let prior: ShortcutDetails;
    try { prior = shell.readShortcutLink(file); } catch { continue; }
    if (path.win32.normalize(prior.target).toLowerCase() !== path.win32.normalize(paths.executable).toLowerCase()) continue;
    if (!shell.writeShortcutLink(file, 'update', { target: paths.executable, cwd: path.dirname(paths.executable),
      appUserModelId: APP_ID, icon: windowsTaskbarIconPath(paths.resources), iconIndex: 0, description: PRODUCT_NAME }))
      throw new Error('Windows could not update the OneCode shortcut identity.');
  }
}
