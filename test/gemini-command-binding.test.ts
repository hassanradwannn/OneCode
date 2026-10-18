import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { performance } from 'node:perf_hooks';
import { makeTempDir, removeTempDir, SAMPLE_BRIEF } from './helpers.js';
vi.mock('electron', () => ({ safeStorage: { isAsyncEncryptionAvailable: async () => true,
  getSelectedStorageBackend: () => 'gnome_libsecret', encryptStringAsync: async (value: string) => Buffer.from(value),
  decryptStringAsync: async (value: Buffer) => ({ result: value.toString(), shouldReEncrypt: false }) }, clipboard: {}, shell: {} }));
const { defaultConfig, initConfigPath, saveConfig } = await import('../src/main/config.js');
const { initSecretsPath, resetSecretsCacheForTests } = await import('../src/main/secrets.js');
const { initDurableStore, flushDurable, resetDurableForTests, writeDurableNow } = await import('../src/main/durable.js');
const { initSessionStore, getSession, listSessions, findSessionByConversation, createSession, rebindSession,
  flushSessions, resetSessionStoreForTests } = await import('../src/main/session/store.js');
const { resetRecorderForTests, flushRecorder } = await import('../src/main/session/recorder.js');
const { initGeminiBindings, resetGeminiBindingsForTests, authenticateGeminiBinding, GEMINI_COMMAND_ACK_WAIT_MS } = await import('../src/main/gemini/bindings.js');
const { spawn, resetSwarm, resetAgentsForTests, agentConversation, currentRunId, onSwarmPersistNow } = await import('../src/main/agents.js');
const { openContinuationNow, attachSummary, continuationByToken } = await import('../src/main/session/continuation.js');
const { startBridge, stopBridge, bridgePort, resetBridgeForTests, pendingCommands, setBrowserOpener,
  queueResume, cancelWorkerCommands, saveGeminiHandoff } = await import('../src/main/bridge.js');
const { APP_VERSION, BRIDGE_PROTOCOL } = await import('../src/main/version.js');
const { startMcpServer } = await import('../src/main/mcp/server.js');
const { getConfig } = await import('../src/main/config.js');

const CHAT_A = '1111111111111111', CHAT_B = '2222222222222222', CHAT_C = '3333333333333333';
const BROWSER = 'geminibrowseraaaa1111', OTHER = 'geminibrowserbbbb2222';
const DOCUMENT = '01234567-89ab-cdef-0123-456789abcdef', CLIENT = 'exactDocumentClient';
let directory: string, bearer: string;
const pause = () => new Promise(resolve => setTimeout(resolve, 75));
async function post(route: string, body: unknown, browser = BROWSER): Promise<{ status: number; data: any }> {
  const result = await fetch(`http://127.0.0.1:${bridgePort()}${route}`, { method: 'POST', headers: {
    'content-type': 'application/json', 'x-extension-version': APP_VERSION, 'x-extension-protocol': String(BRIDGE_PROTOCOL),
    'x-extension-browser': browser, ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(body) });
  return { status: result.status, data: await result.json() };
}
const proof = (id: string) => ({ id, client: CLIENT, tab_id: 27, document_id: DOCUMENT });
beforeEach(async () => {
  directory = await makeTempDir('gemini-command-binding-'); bearer = '';
  resetBridgeForTests(); resetAgentsForTests(); resetRecorderForTests(); resetSecretsCacheForTests();
  initConfigPath(directory); initSecretsPath(directory); initDurableStore(directory); initSessionStore(directory);
  onSwarmPersistNow(snapshot => writeDurableNow('swarm', snapshot));
  const config = defaultConfig(); config.multiAgent.enabled = true;
  await saveConfig(config); await initGeminiBindings(directory); await startBridge();
  setBrowserOpener(async () => undefined);
  const paired = await post('/pair', {}); expect(paired.status).toBe(200); bearer = paired.data.token;
});
afterEach(async () => {
  vi.restoreAllMocks(); resetSwarm(); await stopBridge(); await flushRecorder(); await flushSessions(); await flushDurable();
  resetBridgeForTests(); resetRecorderForTests(); resetSessionStoreForTests(); resetDurableForTests();
  onSwarmPersistNow(null);
  await resetGeminiBindingsForTests(); resetSecretsCacheForTests(); await removeTempDir(directory);
});
async function worker() {
  await createSession({ conversationId: CHAT_A });
  spawn({ workers: [{ task: 'Read only this worker scratch task.' }], caller: { conversationId: CHAT_A } });
  const id = pendingCommands()[0]!.id;
  const redeemed = await post('/commands/redeem', { id, client: CLIENT });
  expect(redeemed.status, JSON.stringify(redeemed.data)).toBe(200);
  return id;
}
async function resume() {
  const source = await createSession({ conversationId: CHAT_A });
  const entry = await openContinuationNow(source.id, CHAT_A, false);
  expect(await attachSummary(entry.token, SAMPLE_BRIEF)).not.toBeNull();
  const command = queueResume(source.id, entry.token)!;
  expect((await post('/commands/redeem', { id: command.id, client: CLIENT })).status).toBe(200);
  return { id: command.id, sessionId: source.id, token: entry.token };
}
async function binding(id: string) {
  const result = await post('/gemini/binding', { conversation_id: CHAT_B, command: proof(id) });
  expect(result.status, JSON.stringify(result.data)).toBe(200); return result.data;
}

describe('Gemini worker and Resume command warmup capabilities', () => {
  it('leaves an MCP-saved handoff opening for its owning browser instead of discarding it in a tool reply', async () => {
    const source = await createSession({ conversationId: CHAT_A });
    await post('/status', { openConversations: [CHAT_A] });
    const entry = await openContinuationNow(source.id, CHAT_A, false);
    const document = { provider: 'gemini', tabId: 27, documentId: DOCUMENT, accountPath: '/u/0' };
    const checkpoint = (extra: object) => post('/compact', { conversationId: CHAT_A, token: entry.token, sourceDocument: document, ...extra });
    expect((await checkpoint({ sourceAttempt: true })).data.allowed).toBe(true);
    expect((await checkpoint({ sourceDispatch: true })).data.armed).toBe(true);
    const messageId = `gemini:${CHAT_A}:user:0123456789abcdef`;
    await post('/events', { conversationId: CHAT_A, events: [
      { kind: 'user_message', time: Date.now(), messageId, text: `[[CLF-HANDOFF:${entry.token}]]\nWrite the handoff.` },
      { kind: 'turn_start', time: Date.now(), turnId: 'handoff-test-turn' }
    ] });
    expect((await checkpoint({ sourceMessageId: messageId })).data.bound).toBe(true);
    const credential = await post('/gemini/binding', { conversation_id: CHAT_A });
    expect(credential.status, JSON.stringify(credential.data)).toBe(200);
    const evidence = await authenticateGeminiBinding(credential.data);
    const saved = await saveGeminiHandoff(entry.token, SAMPLE_BRIEF, evidence);
    expect(saved.stored).toBe(true);
    const foreign = await post('/status', { openConversations: [] }, OTHER);
    expect(foreign.data.placement).toBeNull();
    const delivery = await post('/status', { openConversations: [CHAT_A] });
    expect(delivery.data.placement).toMatchObject({ id: saved.command_id, homeConversationId: CHAT_A });
    expect((await post('/status', { openConversations: [CHAT_A] })).data.placement).toBeNull();
  });
  it.each(['before ACK', 'after ACK'] as const)('keeps the exact worker task key dormant through approval policy refresh %s', async phase => {
    const id = await worker(), credential = await binding(id);
    const ack = () => post('/commands/ack', { id, client: CLIENT, status: 'sent', conversationId: CHAT_B });
    if (phase === 'after ACK') expect((await ack()).data.committed).toBe(true);
    const policy = await post('/gemini/binding', { conversation_id: CHAT_B });
    expect(policy.status, JSON.stringify(policy.data)).toBe(200);
    expect(policy.data.session_key).toBe(credential.session_key);
    let authorized = false;
    const call = authenticateGeminiBinding(credential).then(value => { authorized = true; return value; });
    void call.catch(() => undefined);
    if (phase === 'before ACK') {
      await pause(); expect(authorized).toBe(false);
      expect((await ack()).data.committed).toBe(true);
    }
    expect((await call).sessionId).toBe(credential.session_id);
  });

  it('cannot refresh a cancelled dormant worker into a chat-only grant', async () => {
    const id = await worker(), credential = await binding(id);
    cancelWorkerCommands('cancel the exact prepared task');
    const policy = await post('/gemini/binding', { conversation_id: CHAT_B });
    expect(policy.status).toBe(409);
    expect(policy.data.error).toBe('GEMINI_COMMAND_NOT_OWNED');
    await expect(authenticateGeminiBinding(credential)).rejects.toThrow('GEMINI_COMMAND_NOT_OWNED');
  });

  it('finishes the exact authenticated worker through code mode when the native direct tool list is cached', async () => {
    const id = await worker(), credential = await binding(id);
    expect((await post('/commands/ack', { id, client: CLIENT, status: 'sent', conversationId: CHAT_B })).data.committed).toBe(true);
    const config = getConfig();
    const endpoint = await startMcpServer(() => ({ roots: config.roots, caps: config.capabilities, readOnly: false, agentTools: true }));
    try {
      const reply = await fetch(endpoint.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'exec', arguments: {
          conversation_id: CHAT_B, session_key: credential.session_key,
          code: 'text(await tools.agents({action:"finish",result:"RESULT: fixture verified. CHANGES: none. VALIDATION: exact worker. BLOCKERS: none."}));'
        } } }) });
      const raw = await reply.text();
      expect(raw).toContain('recorded for the prime');
      expect(raw).not.toContain('DIRECT_CALL_REQUIRED');
      expect(raw).not.toContain('CALLER_IDENTITY_REQUIRED');
    } finally { await endpoint.stop(); }
  });
  it('reserves one worker history but grants execution only after the actual task receipt binds the broker', async () => {
    const id = await worker(), credential = await binding(id), runId = currentRunId()!;
    expect((await getSession(credential.session_id))?.origin).toMatchObject({ kind: 'worker', agentId: 'worker-1' });
    expect(agentConversation('worker-1', runId)).toBeNull();
    expect((await listSessions()).filter(row => row.conversationId === CHAT_B)).toHaveLength(1);
    let authorized = false;
    const call = authenticateGeminiBinding(credential).then(value => { authorized = true; return value; });
    void call.catch(() => undefined);
    await pause(); expect(authorized).toBe(false);
    const ack = await post('/commands/ack', { id, client: CLIENT, status: 'sent', conversationId: CHAT_B });
    expect(ack.data.committed, JSON.stringify(ack.data)).toBe(true);
    expect((await call).sessionId).toBe(credential.session_id);
    expect(agentConversation('worker-1', runId)).toBe(CHAT_B);
    expect((await findSessionByConversation(CHAT_B, { requireUnique: true }))?.id).toBe(credential.session_id);
  });

  it('keeps Resume on A through warmup, with no shadow B session, then activates after canonical Send commit', async () => {
    const { id, sessionId, token } = await resume(), credential = await binding(id);
    expect(credential.session_id).toBe(sessionId);
    expect((await getSession(sessionId))?.conversationId).toBe(CHAT_A);
    expect(await findSessionByConversation(CHAT_B)).toBeNull();
    expect(continuationByToken(token)?.destinationSend.state).toBe('not-attempted');
    let authorized = false;
    const call = authenticateGeminiBinding(credential).then(value => { authorized = true; return value; });
    void call.catch(() => undefined);
    await pause(); expect(authorized).toBe(false);
    expect((await post('/compact', { token, commandId: id, client: CLIENT, destinationAttempt: true })).data.allowed).toBe(true);
    expect((await post('/compact', { token, commandId: id, client: CLIENT, destinationDispatch: true })).data.armed).toBe(true);
    const ack = await post('/commands/ack', { id, client: CLIENT, status: 'sent', conversationId: CHAT_B });
    expect(ack.data.committed, JSON.stringify(ack.data)).toBe(true);
    expect((await call).sessionId).toBe(sessionId);
    expect((await getSession(sessionId))?.conversationId).toBe(CHAT_B);
    expect((await listSessions()).filter(row => row.conversationId === CHAT_B).map(row => row.id)).toEqual([sessionId]);
  });

  it('refuses foreign browser/client/document, a second warmup route, and an ACK for a different chat', async () => {
    const id = await worker();
    expect((await post('/gemini/binding', { conversation_id: CHAT_B, command: proof(id) }, OTHER)).status).toBe(409);
    expect((await post('/gemini/binding', { conversation_id: CHAT_B, command: { ...proof(id), client: 'anotherDocument' } })).status).toBe(409);
    await binding(id);
    expect((await post('/gemini/binding', { conversation_id: CHAT_B, command: { ...proof(id), document_id: 'anotherDocument' } })).status).toBe(409);
    expect((await post('/gemini/binding', { conversation_id: CHAT_C, command: proof(id) })).status).toBe(409);
    expect((await post('/commands/ack', { id, client: CLIENT, status: 'sent', conversationId: CHAT_C })).status).toBe(409);
    expect(agentConversation('worker-1', currentRunId()!)).toBeNull();
  });

  it('fails dormant authentication immediately when the owning worker command is cancelled', async () => {
    const id = await worker(), credential = await binding(id);
    const call = authenticateGeminiBinding(credential);
    const rejected = expect(call).rejects.toThrow('GEMINI_COMMAND_NOT_OWNED');
    await pause(); cancelWorkerCommands('test cancellation'); await rejected;
    expect(agentConversation('worker-1', currentRunId()!)).toBeNull();
  });

  it('never grants a prepared Resume key after the durable source changed', async () => {
    const { id, sessionId } = await resume(), credential = await binding(id);
    expect(await rebindSession(sessionId, CHAT_A, CHAT_C)).toBe(true);
    await expect(authenticateGeminiBinding(credential)).rejects.toThrow('GEMINI_COMMAND_NOT_OWNED');
    expect((await post('/gemini/binding', { conversation_id: CHAT_B, command: proof(id) })).status).toBe(409);
  });

  it('invalidates the old document capability when an unattempted Resume is durably claimed by its replacement', async () => {
    const { id, sessionId } = await resume(), credential = await binding(id);
    const replacement = await post('/commands/redeem', { id, client: 'replacementDocument' });
    expect(replacement.status, JSON.stringify(replacement.data)).toBe(200);
    await expect(authenticateGeminiBinding(credential)).rejects.toThrow('GEMINI_COMMAND_NOT_OWNED');
    expect((await post('/gemini/binding', { conversation_id: CHAT_B, command: proof(id) })).status).toBe(409);
    const rebound = await post('/gemini/binding', { conversation_id: CHAT_B,
      command: { ...proof(id), client: 'replacementDocument', document_id: 'replacement-document' } });
    expect(rebound.status, JSON.stringify(rebound.data)).toBe(200);
    expect(rebound.data.session_key).not.toBe(credential.session_key);
    expect((await getSession(sessionId))?.conversationId).toBe(CHAT_A);
    expect(await findSessionByConversation(CHAT_B)).toBeNull();
  });

  it('refuses a worker warmup route that already belongs to unrelated local work', async () => {
    const id = await worker(), foreign = await createSession({ conversationId: CHAT_B });
    expect((await post('/gemini/binding', { conversation_id: CHAT_B, command: proof(id) })).status).toBe(409);
    expect((await getSession(foreign.id))?.origin).toBeNull();
    expect(agentConversation('worker-1', currentRunId()!)).toBeNull();
  });

  it('bounds the wait for an absent actual task ACK without activating a worker from warmup', async () => {
    const id = await worker(), credential = await binding(id), now = performance.now();
    const clock = vi.spyOn(performance, 'now').mockReturnValue(now);
    const call = authenticateGeminiBinding(credential);
    const rejected = expect(call).rejects.toThrow('GEMINI_COMMAND_ACK_PENDING');
    await pause(); clock.mockReturnValue(now + GEMINI_COMMAND_ACK_WAIT_MS + 1); await rejected; clock.mockRestore();
    expect(agentConversation('worker-1', currentRunId()!)).toBeNull();
    expect(pendingCommands().map(row => row.id)).toContain(id);
  });
});
