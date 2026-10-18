import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { makeTempDir, removeTempDir } from './helpers.js';
vi.mock('electron', () => ({ safeStorage: { isAsyncEncryptionAvailable: async () => true,
  getSelectedStorageBackend: () => 'gnome_libsecret', encryptStringAsync: async (value: string) => Buffer.from(value),
  decryptStringAsync: async (value: Buffer) => ({ result: value.toString(), shouldReEncrypt: false }) }, clipboard: {}, shell: {} }));
const { defaultConfig, initConfigPath, getConfig, saveConfig } = await import('../src/main/config.js');
const { initSecretsPath, resetSecretsCacheForTests } = await import('../src/main/secrets.js');
const { initDurableStore, flushDurable, resetDurableForTests, writeDurableNow } = await import('../src/main/durable.js');
const store = await import('../src/main/session/store.js');
const recorder = await import('../src/main/session/recorder.js');
const inputs = await import('../src/main/session/input.js');
const { recordDeliveredInput } = await import('../src/main/session/input-history.js');
const bindings = await import('../src/main/session/local-binding.js');
const gemini = await import('../src/main/gemini/bindings.js');
const bridge = await import('../src/main/bridge.js');
const agents = await import('../src/main/agents.js');
const { startMcpServer } = await import('../src/main/mcp/server.js');
const { prepareSkillFollowup } = await import('../src/main/session/prompt.js');
const { resetGoalStateForTests } = await import('../src/main/goal.js');
const { resetWorkspaces } = await import('../src/main/workspace.js');
const { setChatBlocked, resetBlockedChatsForTests } = await import('../src/main/session/blocked-chats.js');
const { APP_VERSION, BRIDGE_PROTOCOL } = await import('../src/main/version.js');
const CHAT = '11111111-1111-4111-8111-111111111111', OTHER = '22222222-2222-4222-8222-222222222222';
const GOOGLE = '3333333333333333', BROWSER = 'fixturebrowseraaaa1111', OWNER = 'exact-document-owner';
let directory: string, sessionId: string, bearer: string;
let endpoint: Awaited<ReturnType<typeof startMcpServer>>, google: typeof endpoint | undefined;
const pause = () => new Promise(resolve => setTimeout(resolve, 75));
const keyOf = (text: string) => text.match(/\/\/ onecode-session: (sk-onecode-session-[A-Za-z0-9_-]{43})/)![1]!;
async function post(route: string, body: unknown) {
  const response = await fetch(`http://127.0.0.1:${bridge.bridgePort()}${route}`, { method: 'POST', headers: {
    'content-type': 'application/json', 'x-extension-version': APP_VERSION, 'x-extension-protocol': String(BRIDGE_PROTOCOL),
    'x-extension-browser': BROWSER, ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(body) });
  return { status: response.status, data: await response.json() as any };
}
async function call(key: string, code: string, target = endpoint, direct?: { name: string; args: object }): Promise<any> {
  const response = await fetch(target.urls.core, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: direct
      ? { name: direct.name, arguments: { ...direct.args, onecode_session_key: key } }
      : { name: 'exec', arguments: { code: `// onecode-session: ${key}\n${code}` } } }) });
  const text = await response.text();
  return JSON.parse(text.startsWith('{') ? text : [...text.matchAll(/^data:\s*(.*)$/gm)].at(-1)![1]!);
}
async function claimed(conversationId: string | null = CHAT, localSession = sessionId) {
  const id = randomUUID();
  await inputs.enqueueInput({ id, sessionId: conversationId ? localSession : null, text: 'Exact user task', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null });
  const result = await post('/input/claim', { id, owner: OWNER, conversationId, requiresAuthorization: true });
  expect(result.data.input).toMatchObject({ id, owner: OWNER, claimedBrowser: BROWSER });
  return { id, key: keyOf(result.data.input.deliveryText), messageId: randomUUID(), conversationId, sessionId: result.data.input.sessionId };
}
async function acknowledge(task: Awaited<ReturnType<typeof claimed>>, conversationId = task.conversationId!) {
  expect((await post('/input/claim', { id: task.id, owner: OWNER, conversationId: task.conversationId, authorize: true })).data.ok).toBe(true);
  expect((await post('/input/ack', { id: task.id, owner: OWNER, conversationId, messageId: task.messageId })).data.ok).toBe(true);
  expect((await inputs.listInputs()).find(row => row.id === task.id)).toMatchObject({ historyAnchored: true });
}
async function start(conversation = CHAT, turnId = 'exact-native-turn') {
  await recorder.recordChatObservations(conversation, [{ kind: 'turn_start', turnId, time: Date.now() }]);
}
const read = 'text(await tools.read({paths:["/scratch/marker.txt"]}));';
beforeEach(async () => {
  directory = await makeTempDir('chatgpt-local-custody-'); bearer = ''; google = undefined;
  agents.resetSwarm(); bridge.resetBridgeForTests(); inputs.resetInputForTests(); recorder.resetRecorderForTests();
  bindings.resetLocalBindingsForTests(); resetSecretsCacheForTests(); resetGoalStateForTests(); resetWorkspaces(); resetBlockedChatsForTests();
  initConfigPath(directory); initSecretsPath(directory); initDurableStore(directory); store.initSessionStore(directory);
  agents.onSwarmPersistNow(snapshot => writeDurableNow('swarm', snapshot));
  const config = defaultConfig(); config.ui.chatProvider = 'chatgpt'; config.roots = [{ name: 'scratch', path: directory }];
  config.multiAgent.enabled = true; config.multiAgent.allowUnattributedCalls = false;
  config.capabilities.create = true; config.capabilities.edit = true;
  await saveConfig(config); await gemini.initGeminiBindings(directory);
  inputs.configureInputDelivery({ applyAutomation: async () => {}, changed: () => {},
    recoveryAllowed: () => true,
    prepareText: (entry, limits, authored, routingInstructions) => prepareSkillFollowup(entry.text, authored, limits, { ...entry, routingInstructions }),
    activity: () => ({ possible: false, exact: false }), recordDelivered: recordDeliveredInput });
  sessionId = (await store.createSession({ conversationId: CHAT })).id;
  await fs.writeFile(path.join(directory, 'marker.txt'), 'scratch fixture');
  await bridge.startBridge(); bridge.setBrowserOpener(async () => undefined); bearer = (await post('/pair', {})).data.token;
  endpoint = await startMcpServer(() => ({ roots: getConfig().roots, caps: getConfig().capabilities, readOnly: false }), {}, 'chatgpt');
});
afterEach(async () => {
  vi.restoreAllMocks(); await endpoint?.stop(); await google?.stop(); agents.resetSwarm(); await bridge.stopBridge(); await recorder.flushRecorder();
  await store.flushSessions(); await flushDurable(); await gemini.resetGeminiBindingsForTests();
  bridge.resetBridgeForTests(); inputs.resetInputForTests(); recorder.resetRecorderForTests(); store.resetSessionStoreForTests(); resetDurableForTests();
  bindings.resetLocalBindingsForTests(); agents.onSwarmPersistNow(null); resetGoalStateForTests(); resetSecretsCacheForTests(); resetWorkspaces();
  await removeTempDir(directory);
});
it('holds an HTTP mutation until the exact input ACK and native turn, then records parent and child with no request ID or credential', async () => {
  const task = await claimed(); let returned = false;
  const code = 'text(await tools.apply_patch({patch:"*** Begin Patch\\n*** Add File: /scratch/hi.txt\\n+hi\\n*** End Patch"}));';
  const request = call(task.key, code).then(result => { returned = true; return result; });
  await pause(); expect(returned).toBe(false); await expect(fs.stat(path.join(directory, 'hi.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  await acknowledge(task); await pause(); expect(returned).toBe(false);
  await start(); expect((await request).result.isError).not.toBe(true);
  expect(await fs.readFile(path.join(directory, 'hi.txt'), 'utf8')).toContain('hi');
  const calls = await store.readRecentEvents(sessionId, 10, { kinds: ['tool_call'] });
  expect(calls).toHaveLength(2);
  for (const event of calls) expect(event).toMatchObject({ turnId: 'exact-native-turn', call: {
    conversationId: CHAT, requestId: null, attribution: 'chatgpt_session_capability', attributionMethod: 'chatgpt_session_capability' } });
  expect(calls.some(event => event.kind === 'tool_call' && event.call.nested)).toBe(true);
  expect(JSON.stringify(calls)).not.toContain(task.key);
});
it('attributes a fresh opening only after its canonical Send binds the reserved session', async () => {
  const task = await claimed(null);
  const request = call(task.key, read);
  await pause(); expect(await store.findSessionByConversation(OTHER)).toBeNull();
  await acknowledge(task, OTHER); await start(OTHER, 'fresh-native-turn');
  expect((await request).result.isError).not.toBe(true);
  expect((await store.findSessionByConversation(OTHER))?.id).toBe(task.sessionId);
});
it('keeps tools authorized above the local context reference and renews exact custody for recovery', async () => {
  await saveConfig({ ...getConfig(), compaction: { ...getConfig().compaction, auto: false } });
  const original = await claimed(); await acknowledge(original); await start();
  const question = await store.readLatestUserMessage(sessionId);
  expect(question?.messageId).toBe(original.messageId);
  await store.upsertMessageEvent(sessionId, { ...question!, wireTokenEstimate: 600_000 });
  expect((await store.getSession(sessionId))!.contextTokens).toBeGreaterThan(getConfig().sessions.limitTokens);
  expect((await call(original.key, read)).result.isError).not.toBe(true);
  await recorder.recordChatObservations(CHAT, [{ kind: 'turn_end', turnId: 'exact-native-turn', outcome: 'failed', time: Date.now() }]);
  expect(await inputs.fileRecoveryInput(sessionId, CHAT, 'exact-native-turn', false, () => true, Date.now(), 'repair-fixture')).toBe(true);
  const recovery = (await inputs.listInputs()).find(row => row.recovery)!;
  const offered = await post('/input/claim', { id: recovery.id, owner: OWNER, conversationId: CHAT, requiresAuthorization: true });
  const fresh = { id: recovery.id, key: keyOf(offered.data.input.deliveryText), messageId: randomUUID(), conversationId: CHAT, sessionId };
  await acknowledge(fresh); await start(CHAT, 'recovered-native-turn');
  expect(fresh.key).not.toBe(original.key);
  expect((await call(fresh.key, read)).result.isError).not.toBe(true);
  expect(JSON.stringify(await call(original.key, read))).toContain('CHATGPT_SESSION_NOT_AUTHORIZED');
});
it('routes simultaneous independent chat credentials to their own histories', async () => {
  const b = await store.createSession({ conversationId: OTHER });
  const [a, other] = await Promise.all([claimed(), claimed(OTHER, b.id)]);
  await acknowledge(a); await acknowledge(other); await start(); await start(OTHER, 'turn-b');
  const results = await Promise.all([call(a.key, read), call(other.key, read)]);
  expect(results.every(result => !result.result.isError)).toBe(true);
  const histories = await Promise.all([sessionId, b.id].map(id => store.readRecentEvents(id, 10, { kinds: ['tool_call'] })));
  expect(histories[0]!.every(event => event.kind === 'tool_call' && event.call.conversationId === CHAT)).toBe(true);
  expect(histories[1]!.every(event => event.kind === 'tool_call' && event.call.conversationId === OTHER)).toBe(true);
});
it.each(['cancel', 'blocked', 'rebound', 'unknown device', 'restart', 'new native question'] as const)('rejects execution after %s', async mode => {
  const task = await claimed();
  if (mode === 'cancel') await inputs.cancelInput(task.id);
  else {
    await acknowledge(task); await start();
    if (mode === 'blocked') await setChatBlocked(CHAT, true);
    if (mode === 'rebound') expect(await store.rebindSession(sessionId, CHAT, OTHER)).toBe(true);
    if (mode === 'restart') bindings.resetLocalBindingsForTests();
    if (mode === 'new native question') {
      await recorder.recordChatObservations(CHAT, [{ kind: 'user_message', messageId: randomUUID(), text: 'Different question', authoredNow: true, time: Date.now() }]);
      await start(CHAT, 'different-turn');
    }
  }
  const key = mode === 'unknown device' ? 'sk-onecode-session-' + 'x'.repeat(43) : task.key;
  expect(JSON.stringify(await call(key, 'text(await tools.apply_patch({patch:"*** Begin Patch\\n*** Add File: /scratch/forbidden.txt\\n+bad\\n*** End Patch"}));'))).toContain('CHATGPT_SESSION_NOT_AUTHORIZED');
  await expect(fs.stat(path.join(directory, 'forbidden.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('keeps ChatGPT and Gemini admissions isolated while serving both concurrently', async () => {
  const task = await claimed(); await acknowledge(task); await start();
  await store.createSession({ conversationId: GOOGLE });
  const key = await gemini.ensureGeminiBinding(GOOGLE);
  google = await startMcpServer(() => ({ roots: getConfig().roots, caps: getConfig().capabilities, readOnly: false }), {}, 'gemini');
  const googleCall = async (args: object) => {
    const response = await fetch(google!.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read', arguments: args } }) });
    return response.text();
  };
  const results = await Promise.all([call(task.key, read), googleCall({ paths: ['/scratch/marker.txt'], conversation_id: key.conversation_id, session_key: key.session_key })]);
  expect(results[0].result.isError).not.toBe(true); expect(results[1]).toContain('scratch fixture');
  expect(JSON.stringify(await call(task.key, read, google))).toContain('GEMINI_SESSION_BINDING_REQUIRED');
  expect(await googleCall({ paths: ['/scratch/marker.txt'], conversation_id: GOOGLE, session_key: task.key })).toContain('GEMINI_SESSION_BINDING_REQUIRED');
});
it('binds a worker only after its own command ACK, then supports direct agent finish authorization', async () => {
  const prime = await claimed(); await acknowledge(prime); await start();
  const discovered = await call(prime.key, 'text(ALL_TOOLS.find(tool => tool.name === "agents"));');
  const description = discovered.result.content.find((part: { type: string }) => part.type === 'text').text;
  const schema = JSON.parse(description).inputSchema;
  expect(schema.properties.workers).toBeDefined();
  expect(schema.properties.tasks).toBeUndefined();
  agents.spawn({ workers: [{ task: 'Write hi in a scratch file.' }], caller: { conversationId: CHAT } });
  const id = bridge.pendingCommands()[0]!.id;
  const redeemed = await post('/commands/redeem', { id, client: OWNER });
  expect(redeemed.status, JSON.stringify(redeemed.data)).toBe(200);
  const key = keyOf(redeemed.data.command.text); let returned = false;
  const request = call(key, read).then(result => { returned = true; return result; });
  await pause(); expect(returned).toBe(false);
  expect((await post('/commands/ack', { id, client: OWNER, status: 'sent', conversationId: OTHER })).data.committed).toBe(true);
  await recorder.recordChatObservations(OTHER, [{ kind: 'user_message', messageId: randomUUID(), text: redeemed.data.command.text, authoredNow: true, time: Date.now() }]);
  await start(OTHER, 'worker-native-turn');
  const response = await request;
  expect(response.result.isError, JSON.stringify(response)).not.toBe(true);
  const worker = await store.findSessionByConversation(OTHER, { requireUnique: true });
  expect(worker?.origin).toMatchObject({ kind: 'worker', agentId: 'worker-1' });
  const result = await call(key, 'text(await tools.agents({action:"finish",result:"RESULT: Worker scratch task finished. CHANGES: none. VALIDATION: read succeeded. BLOCKERS: none."}));');
  expect(result.result.isError, JSON.stringify(result)).not.toBe(true);
  expect(JSON.stringify(result)).not.toContain('CALLER_IDENTITY_REQUIRED');
  expect(JSON.stringify(result)).not.toContain('CHATGPT_SESSION_NOT_AUTHORIZED');
  expect(JSON.stringify(result)).not.toContain('DIRECT_CALL_REQUIRED');
  expect(JSON.stringify(result)).toContain('recorded for the prime');
  const calls = await store.readRecentEvents(worker!.id, 10, { kinds: ['tool_call'] });
  expect(calls.some(event => event.kind === 'tool_call' && event.call.tool === 'agents')).toBe(true);
  agents.resetSwarm();
  expect(JSON.stringify(await call(key, read))).toContain('CHATGPT_SESSION_NOT_AUTHORIZED');
});

it('keeps a refreshed worker credential usable after native turn liveness retires its revival command', async () => {
  const workerChat = randomUUID();
  const prime = await claimed(); await acknowledge(prime); await start();
  agents.spawn({ workers: [{ task: 'Read the scratch marker.' }], caller: { conversationId: CHAT } });
  const initialId = bridge.pendingCommands()[0]!.id;
  const initial = await post('/commands/redeem', { id: initialId, client: OWNER });
  expect((await post('/commands/ack', { id: initialId, client: OWNER, status: 'sent', conversationId: workerChat })).data.committed).toBe(true);
  await recorder.recordChatObservations(workerChat, [{ kind: 'user_message', messageId: randomUUID(), text: initial.data.command.text, authoredNow: true, time: Date.now() }]);
  await start(workerChat, 'worker-first-turn');
  const firstFinish = await call(keyOf(initial.data.command.text), 'text(await tools.agents({action:"finish",result:"Read complete."}));');
  expect(firstFinish.result.isError, JSON.stringify(firstFinish)).not.toBe(true);
  expect((await call(prime.key, 'text(await tools.agents({action:"message",to:"worker-1",text:"Read the marker again."}));')).result.isError).not.toBe(true);
  const revivalId = bridge.pendingCommands()[0]!.id;
  const revival = await post('/commands/redeem', { id: revivalId, client: OWNER, conversationId: workerChat });
  expect(revival.status).toBe(200);
  const key = keyOf(revival.data.command.text);
  expect((await post('/commands/ack', { id: revivalId, client: OWNER, status: 'sent', conversationId: workerChat })).data.committed).toBe(true);
  expect((await post('/events', { conversationId: workerChat, events: [
    { kind: 'user_message', messageId: randomUUID(), text: revival.data.command.text, authoredNow: true, time: Date.now() },
    { kind: 'turn_start', turnId: 'worker-revived-turn', time: Date.now() }
  ] })).status).toBe(200);
  await pause();
  expect(bridge.pendingCommands().some(command => command.id === revivalId)).toBe(false);
  const response = await call(key, read);
  expect(response.result.isError, JSON.stringify(response)).not.toBe(true);
  expect((await call(key, 'text(await tools.agents({action:"finish",result:"Read after revival verified."}));')).result.isError).not.toBe(true);
});

it('delivers explicit Steer in the exact ongoing response and acknowledges it on the next call without leaking to another chat', async () => {
  const task = await claimed(); await acknowledge(task); await start();
  const otherSession = await store.createSession({ conversationId: OTHER });
  const other = await claimed(OTHER, otherSession.id); await acknowledge(other); await start(OTHER, 'other-turn');
  inputs.configureInputDelivery({ changed: () => {}, applyAutomation: async () => {}, recordDelivered: recordDeliveredInput,
    prepareText: (entry, limits, authored, routingInstructions) => prepareSkillFollowup(entry.text, authored, limits, { ...entry, routingInstructions }),
    activity: session => ({ possible: true, exact: true, turnId: session.activeTurnId ?? undefined }) });
  const correction = await inputs.enqueueInput({ id: randomUUID(), sessionId, text: 'STEER_EXACT_CHAT: read actual multi-provider source now',
    mode: 'after-turn', dueAt: 0, model: null, reasoningEffort: null });
  expect(await inputs.sendQueuedInputNow(correction.id, { delivery: 'tool', turnId: 'exact-native-turn' })).toBe(true);
  expect(JSON.stringify(await call(other.key, read))).not.toContain('STEER_EXACT_CHAT');
  expect(JSON.stringify(await call(task.key, read))).toContain('STEER_EXACT_CHAT');
  expect((await inputs.listInputs()).find(row => row.id === correction.id)).toMatchObject({ state: 'tool', toolTurnId: 'exact-native-turn',
    toolGeminiOffer: { attribution: 'chatgpt_session_capability' } });
  await pause(); expect((await call(task.key, read)).result.isError).not.toBe(true);
  expect((await inputs.listInputs()).find(row => row.id === correction.id)).toMatchObject({ state: 'sent', toolTurnId: 'exact-native-turn' });
});
