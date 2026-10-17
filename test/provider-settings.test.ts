// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { initProviderCopy, initProviderSettings } from '../src/renderer/provider-settings.js';
afterEach(() => { document.body.replaceChildren(); });
it('persists either provider selector once and keeps Setup and Settings in sync', () => {
  document.body.innerHTML = '<select id="chatProvider"><option>gemini</option><option>chatgpt</option></select><select id="setupChatProvider"><option>gemini</option><option>chatgpt</option></select>';
  const save = vi.fn(); initProviderSettings(save);
  const settings = document.getElementById('chatProvider') as HTMLSelectElement, setup = document.getElementById('setupChatProvider') as HTMLSelectElement;
  settings.value = 'chatgpt'; settings.dispatchEvent(new Event('change'));
  expect(save).toHaveBeenCalledOnce(); expect(setup.value).toBe('chatgpt');
  setup.value = 'gemini'; setup.dispatchEvent(new Event('change'));
  expect(save).toHaveBeenCalledTimes(2); expect(settings.value).toBe('gemini');
});
it('repaints authored provider copy and gates Gemini skills without rewriting later user content', () => {
  document.body.innerHTML = '<p>Keep app-created Gemini tabs in the background.</p><details id="geminiSkillSetup" data-provider-only="gemini">Gemini skill</details><select><option>Gemini</option><option>ChatGPT</option></select><div id="chats"></div>';
  const paint = initProviderCopy(); document.getElementById('chats')!.textContent = 'My Gemini project';
  paint('chatgpt');
  expect(document.querySelector('p')!.textContent).toContain('ChatGPT');
  expect((document.getElementById('geminiSkillSetup') as HTMLElement).hidden).toBe(true);
  expect(document.getElementById('chats')!.textContent).toBe('My Gemini project');
  expect(document.querySelector('option')!.textContent).toBe('Gemini');
  paint('gemini'); expect(document.querySelector('p')!.textContent).toContain('Gemini');
  expect((document.getElementById('geminiSkillSetup') as HTMLElement).hidden).toBe(false);
});
