import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { APP_VERSION } from '../src/main/version.js';

it('keeps the app, companion and Windows versions aligned', () => {
  const read = (file: string) => JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8'));
  const pkg = read('../package.json');
  const manifest = read('../extension/manifest.json');
  expect(pkg.version).toBe(APP_VERSION);
  expect(manifest.version).toBe(APP_VERSION);
  expect(manifest.version_name).toBe(APP_VERSION);
  expect(pkg.shortVersionWindows).toBe(APP_VERSION + '.0');
  // Let electron-builder derive FileVersion from the release version. An old
  // override makes an otherwise successful installation look unsuccessful.
  expect(readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8')).not.toMatch(/^buildVersion\s*:/m);
});
