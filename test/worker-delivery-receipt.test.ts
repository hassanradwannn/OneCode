import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHAT_PROVIDERS, type ChatProvider } from '../src/shared/chat-provider.js';
import { makeTempDir, removeTempDir } from './helpers.js';
vi.mock('electron', () => ({ safeStorage: { isAsyncEncryptionAvailable: async () => true,
  getSelectedStorageBackend: () => 'gnome_libsecret', encryptStringAsync: async (value: string) => Buffer.from(value),
  decryptStringAsync: async (value: Buffer) => ({ result: value.toString(), shouldReEncrypt: false }) }, clipboard: {}, shell: {} }));
const { initConfigPath, getConfig } = await import('../src/main/config.js');
const { initSecretsPath, resetSecretsCacheForTests } = await import('../src/main/secrets.js');
const { initDurableStore, flushDurable, readDurable, resetDurableForTests, writeDurableNow } = await import('../src/main/durable.js');
const store = await import('../src/main/session/store.js');
const recorder = await import('../src/main/session/recorder.js');
const agents = await import('../src/main/agents.js');
const bridge = await import('../src/main/bridge.js');
const google = await import('../src/main/gemini/bindings.js');
const local = await import('../src/main/session/local-binding.js');
const { withMcpProvider } = await import('../src/main/mcp/provider-context.js');
const { APP_VERSION, BRIDGE_PROTOCOL } = await import('../src/main/version.js');

type Adapter = {
  conversation: () => string;
  credential: (id: string, text: string, conversation: string) => Promise<unknown>;
  authenticate: (credential: unknown) => Promise<{ conversationId: string; sessionId: string }>;
};
const adapters: Record<ChatProvider, Adapter> = {
  chatgpt: {
    conversation: randomUUID,
    credential: async (_id, text) => text.match(/\/\/ onecode-session: (sk-onecode-session-[A-Za-z0-9_-]{43})/)![1]!,
    authenticate: async key => (await withMcpProvider('chatgpt', () => local.authenticateChatgptExec('exec', {
      code: `// onecode-session: ${key}\ntext("read-only admission check");`
    }))).evidence!
  },
  gemini: {
    conversation: () => randomUUID().replaceAll('-', '').slice(0, 16),
    credential: async (id, _text, conversation) => {
      const response = await post('/gemini/binding', { conversation_id: conversation,
        command: { id, client: OWNER, tab_id: 27, document_id: 'exact-worker-document' } });
      expect(response.status).toBe(200);
      return response.data;
    },
    authenticate: google.authenticateGeminiBinding
  }
};
it('requires a worker-delivery test adapter for every provider', () => {
  expect(Object.keys(adapters).sort()).toEqual([...CHAT_PROVIDERS].sort());
});

const OWNER = 'worker-delivery-document', BROWSER = 'workerdeliverybrowser1111';
let bearer: string;
async function post(route: string, body: unknown): Promise<{ status: number; data: any }> {
  const response = await fetch(`http://127.0.0.1:${bridge.bridgePort()}${route}`, { method: 'POST', headers: {
    'content-type': 'application/json', 'x-extension-version': APP_VERSION, 'x-extension-protocol': String(BRIDGE_PROTOCOL),
    'x-extension-browser': BROWSER, ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
}

describe.each(CHAT_PROVIDERS)('%s worker delivery receipts', provider => {
  let directory: string, prime: string, worker: string, initialCredential: unknown;
  beforeEach(async () => {
    directory = await makeTempDir('worker-delivery-receipt-'); bearer = '';
    bridge.resetBridgeForTests(); agents.resetAgentsForTests(); recorder.resetRecorderForTests(); local.resetLocalBindingsForTests();
    resetSecretsCacheForTests(); initConfigPath(directory); initSecretsPath(directory); initDurableStore(directory); store.initSessionStore(directory);
    const config = getConfig(); config.ui.chatProvider = provider; config.multiAgent.enabled = true;
    agents.onSwarmPersistNow(snapshot => writeDurableNow('swarm', snapshot));
    await google.initGeminiBindings(directory); await bridge.startBridge(); bridge.setBrowserOpener(async () => undefined);
    const paired = await post('/pair', {}); expect(paired.status).toBe(200); bearer = paired.data.token;
    prime = adapters[provider].conversation(); worker = adapters[provider].conversation();
    await store.createSession({ conversationId: prime });
    agents.spawn({ workers: [{ task: 'Read-only worker receipt test.' }], caller: { conversationId: prime } });
    const id = bridge.pendingCommands()[0]!.id;
    const initial = await post('/commands/redeem', { id, client: OWNER });
    expect(initial.status).toBe(200);
    initialCredential = await adapters[provider].credential(id, initial.data.command.text, worker);
    expect((await post('/commands/ack', { id, client: OWNER, status: 'sent', conversationId: worker })).data.committed).toBe(true);
    await observe('initial-worker-turn', 'Initial worker task.');
    agents.finishAgent({ conversationId: worker }, 'Initial read completed.');
    agents.sendMessage({ conversationId: prime }, 'worker-1', 'Read again after waking.');
    agents.requestWorkerRevivals(['worker-1'], agents.currentRunId()!);
  });
  afterEach(async () => {
    await bridge.stopBridge(); await recorder.flushRecorder(); await store.flushSessions(); await flushDurable();
    bridge.resetBridgeForTests(); agents.resetAgentsForTests(); recorder.resetRecorderForTests(); store.resetSessionStoreForTests();
    resetDurableForTests(); local.resetLocalBindingsForTests(); await google.resetGeminiBindingsForTests(); resetSecretsCacheForTests();
    await removeTempDir(directory);
  });
  async function observe(turnId: string, text: string) {
    expect((await post('/events', { conversationId: worker, events: [
      { kind: 'user_message', messageId: randomUUID(), text, authoredNow: true, time: Date.now() },
      { kind: 'turn_start', turnId, time: Date.now() }
    ] })).status).toBe(200);
  }
  it.each(['before', 'after'] as const)('preserves authorization and idempotent ACK when the native turn arrives %s Send ACK', async order => {
    const id = bridge.pendingCommands()[0]!.id;
    const redeemed = await post('/commands/redeem', { id, client: OWNER, conversationId: worker });
    expect(redeemed.status).toBe(200);
    const credential = await adapters[provider].credential(id, redeemed.data.command.text, worker);
    if (order === 'before') await observe('revived-worker-turn', redeemed.data.command.text);
    const ack = { id, client: OWNER, conversationId: worker, status: 'sent' };
    expect((await post('/commands/ack', ack)).data.committed).toBe(true);
    if (order === 'after') await observe('revived-worker-turn', redeemed.data.command.text);
    await expect.poll(() => bridge.pendingCommands().some(command => command.id === id)).toBe(false);
    expect((await post('/commands/ack', ack)).data.committed).toBe(true);
    expect((await post('/commands/ack', { ...ack, client: 'foreign-document' })).status).toBe(409);
    const evidence = await adapters[provider].authenticate(credential);
    expect(evidence.conversationId).toBe(worker);
    expect(evidence.sessionId).toBe((await store.findSessionByConversation(worker, { requireUnique: true }))?.id);
    await expect(adapters[provider].authenticate(initialCredential)).rejects.toThrow(/NOT_AUTHORIZED/);
    const ledger = await readDurable<{ receipts: { id: string; committed: boolean }[] }>('bridge-commands');
    expect(ledger?.receipts.find(receipt => receipt.id === id)?.committed).toBe(true);
  });
  it('keeps a revival grant dormant before Send ACK and rejects it after cancellation', async () => {
    const id = bridge.pendingCommands()[0]!.id;
    const redeemed = await post('/commands/redeem', { id, client: OWNER, conversationId: worker });
    const credential = await adapters[provider].credential(id, redeemed.data.command.text, worker);
    let settled = false;
    const admission = adapters[provider].authenticate(credential).finally(() => { settled = true; });
    const rejected = expect(admission).rejects.toThrow(/NOT_AUTHORIZED|COMMAND_NOT_OWNED/);
    await new Promise(resolve => setTimeout(resolve, 75));
    expect(settled).toBe(false);
    bridge.cancelWorkerCommands('cancelled before Send');
    await rejected;
    expect((await post('/commands/ack', { id, client: OWNER, conversationId: worker, status: 'sent' })).status).toBe(404);
  });
});
