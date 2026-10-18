import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHAT_PROVIDERS, type ChatProvider } from '../src/shared/chat-provider.js';
import { makeTempDir, removeTempDir, SAMPLE_BRIEF } from './helpers.js';
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
const continuations = await import('../src/main/session/continuation.js');
const { startMcpServer } = await import('../src/main/mcp/server.js');
const inputs = await import('../src/main/session/input.js');
const { recordDeliveredInput } = await import('../src/main/session/input-history.js');

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

describe.each(CHAT_PROVIDERS)('%s successor tool authorization', provider => {
  let directory: string;
  beforeEach(async () => {
    directory = await makeTempDir('successor-tool-authorization-'); bearer = '';
    bridge.resetBridgeForTests(); agents.resetAgentsForTests(); recorder.resetRecorderForTests(); local.resetLocalBindingsForTests();
    resetSecretsCacheForTests(); initConfigPath(directory); initSecretsPath(directory); initDurableStore(directory); store.initSessionStore(directory);
    const config = getConfig(); config.ui.chatProvider = provider === 'chatgpt' ? 'gemini' : 'chatgpt';
    config.multiAgent.enabled = false; config.multiAgent.allowUnattributedCalls = false;
    inputs.configureInputDelivery({ activity: () => ({ possible: false, exact: false }), changed: () => {},
      applyAutomation: async () => {}, recordDelivered: recordDeliveredInput });
    await google.initGeminiBindings(directory); await bridge.startBridge(); bridge.setBrowserOpener(async () => undefined);
    bearer = (await post('/pair', {})).data.token;
  });
  afterEach(async () => {
    await bridge.stopBridge(); await recorder.flushRecorder(); await store.flushSessions(); await flushDurable();
    vi.restoreAllMocks(); inputs.resetInputForTests();
    bridge.resetBridgeForTests(); recorder.resetRecorderForTests(); store.resetSessionStoreForTests(); resetDurableForTests();
    await google.resetGeminiBindingsForTests(); local.resetLocalBindingsForTests(); resetSecretsCacheForTests(); await removeTempDir(directory);
  });
  it('stops displaying Active after completion while preserving a newer turn', async () => {
    const conversation = adapters[provider].conversation();
    const session = await store.createSession({ conversationId: conversation });
    const observe = (events: unknown[]) => post('/events', { conversationId: conversation, events });
    const displayed = async () => bridge.sessionActivityExpiresAt((await store.getSession(session.id))!);
    await observe([
      { kind: 'user_message', messageId: 'question-one', text: 'Hi', authoredNow: true, time: Date.now() },
      { kind: 'turn_start', turnId: 'first-turn', time: Date.now() }
    ]);
    expect(await displayed()).toBeGreaterThan(Date.now());
    await observe([{ kind: 'turn_end', turnId: 'first-turn', outcome: 'completed', time: Date.now() }]);
    expect(await displayed()).toBeNull();
    await observe([
      { kind: 'user_message', messageId: 'question-two', text: 'More work', authoredNow: true, time: Date.now() },
      { kind: 'turn_start', turnId: 'second-turn', time: Date.now() }
    ]);
    expect(await displayed()).toBeGreaterThan(Date.now());
    await observe([{ kind: 'turn_end', turnId: 'first-turn', outcome: 'completed', time: Date.now() }]);
    expect(await displayed()).toBeGreaterThan(Date.now());
  });
  it('waits for a delayed first-message receipt and rotates an unsent replacement document credential', async () => {
    const conversation = adapters[provider].conversation();
    const session = await store.createSession({ conversationId: conversation });
    const inputId = randomUUID();
    const deliveredOwner = provider === 'gemini' ? '27:replacement-document:0' : OWNER;
    await inputs.enqueueInput({ id: inputId, sessionId: session.id, chatProvider: provider, text: 'Complete the first task.', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null });
    const credentialFor = async (owner: string) => {
      const document = owner === OWNER ? 'replacement-document' : 'first-document';
      const inputOwner = provider === 'gemini' ? `27:${document}:0` : owner;
      const claim = await post('/input/claim', { id: inputId, owner: inputOwner, conversationId: conversation, requiresAuthorization: true });
      expect(claim.status).toBe(200);
      if (provider === 'chatgpt') return claim.data.input.deliveryText.match(/\/\/ onecode-session: (sk-onecode-session-[A-Za-z0-9_-]{43})/)[1];
      const key = await post('/gemini/binding', { conversation_id: conversation,
        input: { id: inputId, owner: inputOwner, tab_id: 27, document_id: document } });
      expect(key.status, JSON.stringify(key.data)).toBe(200);
      return key.data;
    };
    const old = await credentialFor('first-document'), fresh = await credentialFor(OWNER);
    await expect(adapters[provider].authenticate(old)).rejects.toThrow(/NOT_AUTHORIZED|INPUT_NOT_OWNED/);
    const now = performance.now(), clock = vi.spyOn(performance, 'now').mockReturnValue(now);
    let settled = false;
    const pending = adapters[provider].authenticate(fresh).finally(() => { settled = true; });
    void pending.catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 75));
    clock.mockReturnValue(now + 35_000);
    await new Promise(resolve => setTimeout(resolve, 75));
    expect(settled).toBe(false); // The browser's 120-second native receipt window is still open.
    expect((await post('/input/claim', { id: inputId, owner: deliveredOwner, conversationId: conversation, authorize: true })).data.ok).toBe(true);
    const messageId = randomUUID();
    expect((await post('/input/ack', { id: inputId, owner: deliveredOwner, conversationId: conversation, messageId })).data.ok).toBe(true);
    await post('/events', { conversationId: conversation, events: [{ kind: 'turn_start', turnId: 'first-task-turn', time: Date.now() }] });
    expect((await pending).sessionId).toBe(session.id);
    clock.mockRestore();
  });
  it('binds the first resumed plan to its original durable session with the opposite new-chat default', async () => {
    const from = adapters[provider].conversation(), to = adapters[provider].conversation();
    const session = await store.createSession({ conversationId: from });
    const entry = await continuations.openContinuationNow(session.id, from, false);
    await continuations.attachSummary(entry.token, SAMPLE_BRIEF);
    const command = bridge.queueResume(session.id, entry.token)!;
    const redeemed = await post('/commands/redeem', { id: command.id, client: OWNER });
    expect(redeemed.status).toBe(200);
    const credential = await adapters[provider].credential(command.id, redeemed.data.command.text, to);
    let admitted = false;
    const waiting = adapters[provider].authenticate(credential).then(value => { admitted = true; return value; });
    void waiting.catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 75));
    expect(admitted).toBe(false);
    expect((await post('/compact', { token: entry.token, commandId: command.id, client: OWNER, destinationAttempt: true })).data.allowed).toBe(true);
    expect((await post('/compact', { token: entry.token, commandId: command.id, client: OWNER, destinationDispatch: true })).data.armed).toBe(true);
    expect((await post('/commands/ack', { id: command.id, client: OWNER, conversationId: to, status: 'sent' })).data.committed).toBe(true);
    const messageId = provider === 'chatgpt' ? 'resumed-question' : `gemini:${to}:user:0123456789abcdef`;
    expect((await post('/compact', { token: entry.token, conversationId: to, destinationMessageId: messageId })).data.committed).toBe(true);
    await post('/events', { conversationId: to, events: [
      { kind: 'user_message', messageId, text: redeemed.data.command.text, time: Date.now() },
      { kind: 'turn_start', turnId: 'resumed-turn', time: Date.now() }
    ] });
    expect((await waiting).sessionId).toBe(session.id);
    const config = getConfig();
    const endpoint = await startMcpServer(() => ({ roots: [], caps: config.capabilities, readOnly: false, agentTools: false }), {}, provider);
    try {
      const code = 'text(await tools.update_plan({plan:[{step:"Verify resumed session",status:"completed"}]}));';
      const args = provider === 'chatgpt' ? { code: `// onecode-session: ${credential}\n${code}` }
        : { conversation_id: to, session_key: (credential as { session_key: string }).session_key, code };
      const reply = await fetch(endpoint.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'exec', arguments: args } }) });
      expect(await reply.text()).toContain('Plan updated');
      expect((await store.readSessionPlan(session.id))?.plan[0]?.step).toBe('Verify resumed session');
    } finally { await endpoint.stop(); }
    if (provider === 'chatgpt') {
      await post('/events', { conversationId: to, events: [{ kind: 'user_message', messageId: 'later-question', text: 'A different task', time: Date.now() }] });
      await expect(adapters[provider].authenticate(credential)).rejects.toThrow('CHATGPT_SESSION_NOT_AUTHORIZED');
    }
  });
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
