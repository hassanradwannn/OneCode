import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('async function catalogProbe('), source.indexOf('\nlet maintenanceFlight ='));

it.each(['gemini', 'chatgpt'])('discovers %s independently of the opposite default provider', async provider => {
  const created: string[] = [];
  const stored: Record<string, unknown> = {};
  const context: any = {
    URL, Date, setTimeout, clearTimeout,
    selectedProvider: provider === 'gemini' ? 'chatgpt' : 'gemini',
    providerHome: (value: string) => value === 'chatgpt' ? 'https://chatgpt.com/' : 'https://gemini.google.com/app',
    connectionEpoch: 1, token: 'test-only', disconnected: false, modelCatalogFlight: null,
    CHATGPT_TAB_URLS: [], discardProtectedTabs: {}, commandMarkerId: () => null,
    call: vi.fn(async () => ({ ok: true })),
    chrome: { tabs: { query: async () => [], update: async () => {} }, storage: { session: {
      get: async () => stored, set: async (value: any) => Object.assign(stored, value)
    } } },
    createChatTab: async (url: string) => { created.push(url); return { id: 20 }; }
  };
  vm.createContext(context);
  vm.runInContext(code, context);
  const nonce = '384c612a-cfd5-4a36-8e48-49b29fd9c2bd';
  await context.inspectRequestedModels({ nonce, provider, expiresAt: Date.now() + 10000, allowOpen: true });
  expect(created).toEqual([`${context.providerHome(provider)}?cos-model-catalog=${nonce}`]);
  expect(stored.modelCatalogOwner).toEqual({ nonce, tab: 20 });
});
