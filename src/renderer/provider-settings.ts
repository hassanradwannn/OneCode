import { CHAT_PROVIDERS, chatProviderLabel, type ChatProvider } from '../shared/chat-provider.js';
import { providerCopy } from '../shared/provider-copy.js';
import { t, ui } from './i18n.js';

export function populateProviderPicker(select: HTMLSelectElement): void {
  const selected = select.value;
  select.replaceChildren(...CHAT_PROVIDERS.map(provider => {
    const option = document.createElement('option'); option.value = provider; option.textContent = chatProviderLabel(provider); return option;
  }));
  if (CHAT_PROVIDERS.some(provider => provider === selected)) select.value = selected;
}

/** Both selectors enter the same durable settings queue exactly once. */
export function initProviderSettings(save: () => void | Promise<void>): void {
  const settings = document.getElementById('chatProvider') as HTMLSelectElement;
  const setup = document.getElementById('setupChatProvider') as HTMLSelectElement;
  populateProviderPicker(settings); populateProviderPicker(setup);
  settings.addEventListener('change', () => { setup.value = settings.value; void save(); });
  setup.addEventListener('change', () => { settings.value = setup.value; void save(); });
}

/** Capture only the static authored shell, before any chats, files or account content exist. */
export function initProviderCopy(): (provider: ChatProvider) => void {
  // Native guides and provider-only instructions name real service controls.
  // Neutralizing those labels makes setup impossible to follow.
  const nativeCopy = '[data-setup-guide], #pluginMoves, [data-provider-only], [data-provider-names]';
  const copy: Array<{ node: Text; source: string }> = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (!/Gemini|ChatGPT/.test(node.data) ||
        node.parentElement?.closest(`script, style, option, code, [translate="no"], #chatProvider, #setupChatProvider, #composerProviderLabel, ${nativeCopy}`)) continue;
    copy.push({ node, source: node.data });
  }
  const attributes: Array<{ node: Element; property: 'title' | 'placeholder' | 'aria-label'; source: string }> = [];
  for (const node of document.querySelectorAll('[title],[placeholder],[aria-label]')) {
    if (node.closest(`[translate="no"], #chatProvider, #setupChatProvider, ${nativeCopy}`)) continue;
    for (const property of ['title', 'placeholder', 'aria-label'] as const) {
      const source = node.getAttribute(property);
      if (source && /Gemini|ChatGPT/.test(source)) attributes.push({ node, property, source });
    }
  }
  return provider => {
    for (const { node, source } of copy) {
      if (node.isConnected) ui(node, 'textContent', () => providerCopy(t(source), provider));
    }
    for (const { node, property, source } of attributes) {
      if (node.isConnected) ui(node, property, () => providerCopy(t(source), provider));
    }
    for (const element of document.querySelectorAll<HTMLElement>('[data-provider-only]')) {
      element.hidden = element.dataset.providerOnly !== provider;
    }
  };
}
