/**
 * Firefox setup belongs to this project. Never substitute an upstream fork's
 * signed binary for the installed OneCode build. This candidate does not ship
 * a signed Firefox package, so setup opens the explicit support status.
 */
export const FIREFOX_ADDON_ASSET = 'OneCode-Companion-Firefox.xpi';

export function firefoxAddonUrl(version: string): string {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Not a release version');
  return 'https://github.com/hassanradwannn/OneCode/blob/main/docs/WINDOWS-SETUP.md#firefox';
}
