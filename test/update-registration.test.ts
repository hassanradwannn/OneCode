import { expect, it } from 'vitest';
import { registeredInstallTarget } from '../src/main/update-registration.js';
const target = 'D:\\One Code';
const row = { location: target, uninstall: `"${target}\\Uninstall OneCode.exe" /currentuser` };
it('requires matching current-user installer registration for the exact executable directory', () => {
  expect(registeredInstallTarget(`${target}\\OneCode.exe`, [row, { location: null, uninstall: null }])).toBe(target);
  expect(registeredInstallTarget('D:\\unpacked\\OneCode.exe', [row])).toBeNull();
  expect(registeredInstallTarget(`${target}\\OneCode.exe`, [])).toBeNull();
  expect(registeredInstallTarget(`${target}\\OneCode.exe`, [row, { ...row, location: 'D:\\foreign' }])).toBeNull();
  expect(registeredInstallTarget(`${target}\\OneCode.exe`, [{ ...row, uninstall: 'cmd /c anything' }])).toBeNull();
  expect(registeredInstallTarget(`${target}\\OneCode.exe`, [{ ...row, location: null }])).toBeNull();
});
