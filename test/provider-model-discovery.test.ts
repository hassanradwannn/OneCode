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
    resolveProviderUrl: async (url: string) => url,
    geminiRouting: { sameAccount: () => true },
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

it.each(['gemini', 'chatgpt'])('refreshes %s from the selected account page instead of an older discovery helper', async provider => {
  const home = provider === 'gemini' ? 'https://gemini.google.com' : 'https://chatgpt.com';
  const tabs = [
    { id: 10, windowId: 77, active: false, url: `${home}${provider === 'gemini' ? '/u/0/app' : '/'}?cos-model-catalog=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee` },
    { id: 20, windowId: 77, active: true, url: `${home}${provider === 'gemini' ? '/u/1/app' : '/'}` }
  ];
  const stored: Record<string, unknown> = {};
  const inspected: number[] = [];
  const context: any = {
    URL, Date, setTimeout, clearTimeout, selectedProvider: provider,
    providerHome: () => `${home}${provider === 'gemini' ? '/app' : '/'}`,
    resolveProviderUrl: async () => tabs[1]!.url,
    geminiRouting: { sameAccount: (left: string, right: string) => new URL(left).pathname.split('/app')[0] === new URL(right).pathname.split('/app')[0] },
    connectionEpoch: 1, token: 'test-only', disconnected: false, modelCatalogFlight: null,
    CHATGPT_TAB_URLS: [], discardProtectedTabs: {}, commandMarkerId: () => null,
    call: vi.fn(async () => ({ ok: true })),
    activeTabs: null, tabDocuments: { 10: 'old', 20: 'selected' }, tabEpochs: { 10: 1, 20: 1 }, ownsDocument: () => true,
    holdModelCatalogTarget: async (target: any) => { context.modelCatalogTarget = target; },
    releaseModelCatalogTarget: async () => {}, prepareNativeWork: async () => true,
    chrome: { windows: { getLastFocused: async () => ({ id: 77 }) }, tabs: {
      query: async () => tabs, get: async (id: number) => tabs.find(tab => tab.id === id),
      sendMessage: async (id: number, message: any) => {
        if (message.type === 'clf-model-catalog-state') return { ready: true };
        inspected.push(id); return { ok: true };
      }
    }, storage: { session: { get: async () => stored, set: async (value: any) => Object.assign(stored, value) } } }
  };
  vm.createContext(context); vm.runInContext(code, context);
  await context.inspectRequestedModels({ nonce: '384c612a-cfd5-4a36-8e48-49b29fd9c2bd', provider, expiresAt: Date.now() + 10000, allowOpen: true });
  expect(inspected).toEqual([20]);
});

it.each([false, true])('accepts a Gemini catalog only while its inspected account is still selected (switched=%s)', async switched => {
  const nonce = '384c612a-cfd5-4a36-8e48-49b29fd9c2bd';
  const url = 'https://gemini.google.com/u/1/app';
  const context: any = { ownsDocument: () => true, providerForUrl: () => 'gemini', providerHome: () => 'https://gemini.google.com/app',
    resolveProviderUrl: async () => `https://gemini.google.com/u/${switched ? 0 : 1}/app`,
    geminiRouting: { sameAccount: (left: string, right: string) => left === right },
    chrome: { tabs: { get: async () => ({ url }) } },
    currentModelCatalogTarget: async () => ({ tab: 20, url, documentId: 'selected', navigationEpoch: 1 }),
    call: vi.fn(async () => ({ ok: true })) };
  vm.createContext(context);
  const start = source.indexOf('  async model_catalog('), end = source.indexOf('\n  /**', start);
  vm.runInContext(`handler = ({${source.slice(start, end)}}).model_catalog`, context);
  expect(await context.handler({ nonce, models: [{ id: 'available', label: 'Available', efforts: [] }] }, {},
    { tab: 20, documentId: 'selected', navigationEpoch: 1 })).toMatchObject({ ok: !switched });
  expect(context.call).toHaveBeenCalledTimes(switched ? 0 : 1);
});
