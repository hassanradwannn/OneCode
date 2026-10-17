import { expect, it } from 'vitest';
import type { UpdateInfo } from 'electron-updater';
import { validateWindowsUpdate, windowsUpdateChannel } from '../src/main/update-download.js';
const version = '99.0.0', name = 'OneCode-Setup-x64.exe';
const info = () => ({ version, path: name, sha512: Buffer.alloc(64, 13).toString('base64'),
  releaseDate: '2026-10-16', files: [{ url: name, size: 128,
  sha512: Buffer.alloc(64, 13).toString('base64') }] } satisfies UpdateInfo);
it('requires one current-architecture installer from the exact OneCode release', () => {
  expect(() => validateWindowsUpdate(info(), version, name)).not.toThrow();
  const absolute = info(); absolute.files[0]!.url = `https://github.com/hassanradwannn/OneCode/releases/download/v${version}/${name}`;
  expect(() => validateWindowsUpdate(absolute, version, name)).not.toThrow();
  expect(windowsUpdateChannel('x64')).toBe('latest-x64');
  expect(windowsUpdateChannel('arm64')).toBe('latest-arm64');
});
it.each(['version', 'arch', 'foreign', 'upstream', 'multiple', 'hash', 'size', 'web'] as const)('refuses invalid %s metadata before download', failure => {
  const candidate = info();
  if (failure === 'version') candidate.version = '98.0.0';
  if (failure === 'arch') candidate.files[0]!.url = 'OneCode-Setup-arm64.exe';
  if (failure === 'foreign') candidate.files[0]!.url = `https://example.test/${name}`;
  if (failure === 'upstream') candidate.files[0]!.url = `https://github.com/totec448-spec/chat-on-steroids/releases/download/v${version}/${name}`;
  if (failure === 'multiple') candidate.files.push({ ...candidate.files[0]! });
  if (failure === 'hash') candidate.files[0]!.sha512 = 'invalid';
  if (failure === 'size') candidate.files[0]!.size = -1;
  if (failure === 'web') Object.assign(candidate, { packages: { x64: { path: 'anything' } } });
  expect(() => validateWindowsUpdate(candidate, version, name)).toThrow(/does not match/);
});
