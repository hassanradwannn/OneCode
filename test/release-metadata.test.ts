import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { APP_VERSION } from '../src/main/version.js';
import { displayReleaseVersion } from '../src/shared/release-version.js';
import { isNewer } from '../src/shared/types.js';

it('orders the 0.3.4.5 compatibility release between 0.3.4 and 0.3.5', () => {
  expect(displayReleaseVersion('0.3.405')).toBe('0.3.4.5');
  expect(isNewer('0.3.405', '0.3.4')).toBe(true);
  expect(isNewer('0.3.5', '0.3.405')).toBe(true);
  expect(isNewer('0.3.405', '0.3.5')).toBe(false);
});

it('keeps the 0.3.5 package numerically forward of the shipped Windows and Companion versions', () => {
  expect(displayReleaseVersion('0.3.500')).toBe('0.3.5');
  expect(isNewer('0.3.500', '0.3.405')).toBe(true);
  expect(isNewer('0.3.405', '0.3.500')).toBe(false);
  expect(isNewer('0.3.6', '0.3.500')).toBe(true);
});

it('keeps the app, companion and Windows versions aligned', () => {
  const read = (file: string) => JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8'));
  const pkg = read('../package.json');
  const manifest = read('../extension/manifest.json');
  expect(pkg.version).toBe(APP_VERSION);
  expect(manifest.version).toBe(APP_VERSION);
  expect(manifest.version_name).toBe(displayReleaseVersion(APP_VERSION));
  expect(pkg.shortVersionWindows).toBe(APP_VERSION + '.0');
  // Let electron-builder derive FileVersion from the release version. An old
  // override makes an otherwise successful installation look unsuccessful.
  expect(readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8')).not.toMatch(/^buildVersion\s*:/m);
});
