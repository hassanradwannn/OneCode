import { chatProviderLabel, type ChatProvider } from '../shared/chat-provider.js';
import { ui } from './i18n.js';

/** Both selectors enter the same durable settings queue exactly once. */
export function initProviderSettings(save: () => void | Promise<void>): void {
  const settings = document.getElementById('chatProvider') as HTMLSelectElement;
  const setup = document.getElementById('setupChatProvider') as HTMLSelectElement;
  settings.addEventListener('change', () => { setup.value = settings.value; void save(); });
  setup.addEventListener('change', () => { settings.value = setup.value; void save(); });
}

/** Capture only the static authored shell, before any chats, files or account content exist. */
export function initProviderCopy(): (provider: ChatProvider) => void {
  const copy: Array<{ node: Text; source: string }> = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (!node.data.includes('Gemini') || node.data.includes('ChatGPT') ||
        node.parentElement?.closest('script, style, option, code, [translate="no"], #geminiSkillSetup, #composerProviderLabel, [data-provider-only="gemini"]')) continue;
    copy.push({ node, source: node.data });
  }
  return provider => {
    const label = chatProviderLabel(provider);
    for (const { node, source } of copy) {
      if (node.isConnected) ui(node, 'textContent', () => source.replaceAll('Gemini', label));
    }
    for (const element of document.querySelectorAll<HTMLElement>('[data-provider-only]')) {
      element.hidden = element.dataset.providerOnly !== provider;
    }
  };
}
