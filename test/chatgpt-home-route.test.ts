import fs from 'node:fs';
import vm from 'node:vm';
import { expect, it } from 'vitest';
it('proves ChatGPT new-chat ownership at its native root without borrowing Gemini or settings routes', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync('extension/chatgpt-dom.js', 'utf8'), context);
  const api = vm.runInContext('CLF_DOM', context);
  expect(api.provider).toBe('chatgpt');
  expect(api.isAppHomePath('/')).toBe(true); expect(api.isAppHomePath('')).toBe(true);
  for (const route of ['/app', '/plugins', '/settings', '/c/12345678', '/share/12345678']) expect(api.isAppHomePath(route)).toBe(false);
});
