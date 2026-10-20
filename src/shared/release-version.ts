/** Wire/package identity stays compatible with the updater shipped in 0.2.8. */
export function displayReleaseVersion(version: string): string {
  return version === '0.2.805' ? '0.2.8.5' : version === '0.2.905' ? '0.2.9.5'
    : version === '0.3.405' ? '0.3.4.5' : version === '0.3.500' ? '0.3.5'
      : version === '0.3.600' ? '0.3.6' : version === '0.3.700' ? '0.3.7'
        : version === '0.3.701' ? '0.3.7.1' : version === '0.3.705' ? '0.3.7.5'
          : version === '0.3.706' ? '0.3.7.6' : version === '0.3.800' ? '0.3.8'
            : version === '0.3.801' ? '0.3.8.1' : version;
}
