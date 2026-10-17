/** Wire/package identity stays compatible with the updater shipped in 0.2.8. */
export function displayReleaseVersion(version: string): string {
  return version === '0.2.805' ? '0.2.8.5' : version;
}
