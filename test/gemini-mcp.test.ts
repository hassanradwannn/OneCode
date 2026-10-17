import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTempDir, removeTempDir, writeTree } from './helpers.js';

vi.mock('electron', () => ({
  safeStorage: { isAsyncEncryptionAvailable: async () => true, getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: async (value: string) => Buffer.from(value),
    decryptStringAsync: async (value: Buffer) => ({ result: value.toString(), shouldReEncrypt: false }) },
  clipboard: { readText: () => '', writeText: () => undefined }, shell: { openExternal: async () => undefined }
}));

const { getConfig, initConfigPath } = await import('../src/main/config.js');
const { initDurableStore, flushDurable, resetDurableForTests } = await import('../src/main/durable.js');
const { createSession, initSessionStore, flushSessions, readRecentEvents, resetSessionStoreForTests,
  turnHasMcpCall, questionHasMcpCall, conversationHasMcpCallSince } = await import('../src/main/session/store.js');
const { resetRecorderForTests, flushRecorder, recordChatObservations } = await import('../src/main/session/recorder.js');
const { startMcpServer } = await import('../src/main/mcp/server.js');
const { initGeminiBindings, ensureGeminiBinding, prepareGeminiInputBinding, resetGeminiBindingsForTests, authenticateGeminiBinding, revokeGeminiBinding } = await import('../src/main/gemini/bindings.js');
const input = await import('../src/main/session/input.js');
const { recordDeliveredInput } = await import('../src/main/session/input-history.js');
const { unifiedExecManager } = await import('../src/main/codex/manager.js');
const { execOwner, resetExecOwnershipForTests } = await import('../src/main/codex/ownership.js');
const { setChatBlocked, resetBlockedChatsForTests } = await import('../src/main/session/blocked-chats.js');
const { setChatTrusted, resetTrustedChatsForTests } = await import('../src/main/session/trusted-chats.js');
const { resetWorkspaces } = await import('../src/main/workspace.js');
const { dispatch, ok } = await import('../src/main/mcp/kernel.js');
const { currentCaller, emptyEvidence } = await import('../src/main/mcp/call-context.js');
const { DEFAULT_CAPABILITIES } = await import('../src/shared/types.js');
const { getLog } = await import('../src/main/logger.js');
type Credential = Awaited<ReturnType<typeof ensureGeminiBinding>>;
type ToolContext = import('../src/main/mcp/kernel.js').ToolContext;
type Endpoint = Awaited<ReturnType<typeof startMcpServer>>;

const CHAT_A = '1111111111111111';
const CHAT_B = '2222222222222222';
let directory: string;
let endpoint: Endpoint;
let context: ToolContext;
let a: Credential, b: Credential;
const routing = (key: Credential) => ({ conversation_id: key.conversation_id, session_key: key.session_key });

async function rpc(method: string, params: unknown, headers: Record<string, string> = {}, surface: 'core' | 'desktop' | 'plugins' = 'core', server: Endpoint = endpoint): Promise<any> {
  const url = new URL(server.urls[surface]);
  // Match Gemini's native transport: every independent call may reuse RPC id=1.
  const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
        'content-length': Buffer.byteLength(payload), ...headers } }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        const json = raw.startsWith('{') ? raw : [...raw.matchAll(/^data:\s*(.*)$/gm)].at(-1)?.[1] ?? '{}';
        try { resolve({ status: response.statusCode, ...JSON.parse(json) }); } catch (error) { reject(error); }
      });
    });
    request.on('error', reject); request.end(payload);
  });
}
const call = (key: Credential, name: string, args: Record<string, unknown>) => rpc('tools/call', { name, arguments: { ...args, ...routing(key) } });
const text = (reply: any): string => reply.result?.content?.map((part: any) => part.text ?? '').join('\n') ?? JSON.stringify(reply.error);

beforeEach(async () => {
  directory = await makeTempDir('gemini-mcp-');
  initConfigPath(directory); initDurableStore(directory); initSessionStore(directory);
  resetRecorderForTests(); input.resetInputForTests(); resetWorkspaces(); resetExecOwnershipForTests(); resetBlockedChatsForTests(); resetTrustedChatsForTests();
  await writeTree(path.join(directory, 'work'), { 'a/marker.txt': 'chat A marker', 'b/marker.txt': 'chat B marker',
    'a/slow.cjs': "setTimeout(() => { process.stdout.write('A finished\\n'); }, 1500);" });
  const config = getConfig();
  config.ui.chatProvider = 'gemini';
  config.multiAgent.strictChatAllowlistByProvider = undefined;
  config.multiAgent.enabled = false; config.multiAgent.allowUnattributedCalls = false; config.multiAgent.strictChatAllowlist = false;
  config.commandAllowlist.enabled = false;
  config.sessions.record = true;
  config.roots = [{ name: 'work', path: path.join(directory, 'work') }];
  input.configureInputDelivery({ changed: () => {}, activity: () => ({ possible: false, exact: false }),
    applyAutomation: async () => {}, recordDelivered: recordDeliveredInput, prepareText: entry => entry.text });
  context = { roots: [{ name: 'work', path: path.join(directory, 'work') }], caps: { ...DEFAULT_CAPABILITIES,
    browse: true, read: true, metadata: true, command: true, create: true, edit: true }, readOnly: false, sessionTools: false, agentTools: false };
  await initGeminiBindings(directory);
  await createSession({ conversationId: CHAT_A }); await createSession({ conversationId: CHAT_B });
  a = await ensureGeminiBinding(CHAT_A); b = await ensureGeminiBinding(CHAT_B);
  endpoint = await startMcpServer(() => context);
});
afterEach(async () => {
  if (endpoint) await endpoint.stop();
  await unifiedExecManager.terminateAllProcesses();
  await flushRecorder(); await flushSessions(); await flushDurable();
  await resetGeminiBindingsForTests();
  resetRecorderForTests(); input.resetInputForTests(); resetSessionStoreForTests(); resetDurableForTests(); resetBlockedChatsForTests(); resetTrustedChatsForTests();
  await removeTempDir(directory);
});

describe('Gemini routing through the real MCP endpoint and tool engines', () => {
  it('hosts independent Gemini and ChatGPT servers concurrently without sharing credential schemas or URL tokens', async () => {
    const { startProviderMcpServers } = await import('../src/main/mcp/provider-servers.js');
    await endpoint.stop();
    let selected: 'gemini' | 'chatgpt' = 'gemini';
    const pair = await startProviderMcpServers(() => context, {}, () => selected);
    endpoint = pair;
    expect(pair.providers.gemini.port).not.toBe(pair.providers.chatgpt.port);
    const geminiUrls = { ...pair.urls };
    selected = 'chatgpt';
    const chatgptUrls = { ...pair.urls };
    expect(chatgptUrls.core).not.toBe(geminiUrls.core);
    for (const url of [geminiUrls.core, chatgptUrls.core]) {
      const metadata = new URL(url); metadata.pathname = '/.well-known/oauth-protected-resource' + metadata.pathname;
      expect((await (await fetch(metadata)).json()).resource).toBe(url);
    }
    const geminiView = { ...pair, urls: geminiUrls }, chatgptView = { ...pair, urls: chatgptUrls };
    const [geminiList, chatgptList] = await Promise.all([
      rpc('tools/list', {}, {}, 'core', geminiView), rpc('tools/list', {}, {}, 'core', chatgptView)
    ]);
    const geminiRead = geminiList.result.tools.find((tool: any) => tool.name === 'read');
    const chatgptRead = chatgptList.result.tools.find((tool: any) => tool.name === 'read');
    expect(geminiRead.inputSchema.required).toContain('session_key');
    expect(chatgptRead.inputSchema.properties).not.toHaveProperty('session_key');
    const [geminiResult, chatgptResult] = await Promise.all([
      rpc('tools/call', { name: 'read', arguments: { paths: ['/work/a/marker.txt'], ...routing(a) } }, {}, 'core', geminiView),
      rpc('tools/call', { name: 'read', arguments: { paths: ['/work/b/marker.txt'] } }, {}, 'core', chatgptView)
    ]);
    expect(text(geminiResult)).toContain('chat A marker');
    expect(text(chatgptResult)).toContain('chat B marker');
    const missing = await rpc('tools/call', { name: 'read', arguments: { paths: ['/work/a/marker.txt'] } }, { 'x-request-id': 'wfr_spoofed' }, 'core', geminiView);
    expect(text(missing)).toContain('GEMINI_SESSION_BINDING_REQUIRED');
    const wrongPort = new URL(pair.providers.gemini.url); wrongPort.pathname = new URL(pair.providers.chatgpt.url).pathname;
    expect((await fetch(wrongPort, { method: 'POST' })).status).toBe(404);
  });
  it('publishes required routing fields while retaining exact original strict tool validation', async () => {
    const list = await rpc('tools/list', {});
    expect(list.result.tools.map((tool: any) => tool.name)).not.toContain('save_image');
    const read = list.result.tools.find((tool: any) => tool.name === 'read');
    expect(read.inputSchema.required).toEqual(expect.arrayContaining(['conversation_id', 'session_key', 'paths']));
    expect(read.inputSchema.additionalProperties).toBe(false);
    const result = await call(a, 'read', { paths: ['/work/a/marker.txt'] });
    expect(result.result.isError).not.toBe(true); expect(text(result)).toContain('chat A marker');
    const wrong = await call(a, 'read', { paths: ['/work/a/marker.txt'], misspelled: true });
    expect(wrong.error ?? wrong.result?.isError).toBeTruthy();
    expect(JSON.stringify(wrong)).not.toContain(a.session_key);
  });

  it('rejects missing/cross-chat keys on every surface even with a claimed x-request-id', async () => {
    for (const surface of ['core', 'desktop', 'plugins'] as const) {
      const missing = await rpc('tools/call', { name: 'read', arguments: { paths: ['/work/a/marker.txt'] } }, { 'x-request-id': 'wfr_claimed/a' }, surface);
      expect(missing.result.isError).toBe(true); expect(text(missing)).toContain('GEMINI_SESSION_BINDING_REQUIRED');
      const wrong = await rpc('tools/call', { name: 'read', arguments: { paths: ['/work/a/marker.txt'], conversation_id: CHAT_B, session_key: a.session_key } }, {}, surface);
      expect(text(wrong)).toContain('GEMINI_SESSION_NOT_AUTHORIZED');
    }
  });

  it('logs only fixed admission metadata and rejects before a private task can reach the command engine', async () => {
    const prior = new Set(getLog());
    const privateTask = 'PRIVATE_ADMISSION_TASK_MARKER';
    const privateTool = `PRIVATE_TOOL_${a.session_key}`;
    const args = { cmd: `node -e "require('fs').writeFileSync('must-not-execute.txt','${privateTask}')"`,
      workdir: '/work/a', conversation_id: CHAT_B, session_key: a.session_key, private_endpoint: endpoint.url };
    const crossChat = await rpc('tools/call', { name: 'exec_command', arguments: args });
    expect(crossChat.result.isError).toBe(true);
    expect(text(crossChat)).toContain('GEMINI_SESSION_NOT_AUTHORIZED');
    const invalid = await rpc('tools/call', { name: privateTool, arguments: {
      ...args, conversation_id: `${privateTask}\n${endpoint.url}`, session_key: { privateTask } } });
    expect(text(invalid)).toContain('GEMINI_SESSION_BINDING_REQUIRED');
    const missing = await rpc('tools/call', { name: 'exec_command' });
    expect(text(missing)).toContain('GEMINI_SESSION_BINDING_REQUIRED');
    const lines = getLog().filter(entry => !prior.has(entry) && entry.message.startsWith('Gemini MCP admission refused '))
      .map(entry => entry.message);
    expect(lines).toHaveLength(3);
    const metadata = lines.map(line => JSON.parse(line.slice('Gemini MCP admission refused '.length)));
    expect(metadata).toEqual([
      { code: 'GEMINI_SESSION_NOT_AUTHORIZED', tool: 'exec_command', conversationId: CHAT_B, keyPresent: true, keyStringLength: a.session_key.length },
      { code: 'GEMINI_SESSION_BINDING_REQUIRED', tool: 'invalid', conversationId: 'invalid', keyPresent: true, keyStringLength: null },
      { code: 'GEMINI_SESSION_BINDING_REQUIRED', tool: 'exec_command', conversationId: 'invalid', keyPresent: false, keyStringLength: null }
    ]);
    const logged = lines.join('\n');
    for (const privateValue of [a.session_key, b.session_key, privateTask, privateTool, endpoint.url, args.cmd, args.workdir])
      expect(logged).not.toContain(privateValue);
    await expect(fs.stat(path.join(directory, 'work/a/must-not-execute.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readRecentEvents(a.session_id, 20)).some(event => event.kind === 'tool_call')).toBe(false);
    expect((await readRecentEvents(b.session_id, 20)).some(event => event.kind === 'tool_call')).toBe(false);
  });

  it('routes concurrent calls sharing RPC id=1 to separate durable histories with truthful evidence', async () => {
    const [first, second] = await Promise.all([call(a, 'read', { paths: ['/work/a/marker.txt'] }), call(b, 'read', { paths: ['/work/b/marker.txt'] })]);
    expect(text(first)).toContain('chat A marker'); expect(text(second)).toContain('chat B marker');
    for (const [key, own, foreign] of [[a, 'chat A marker', 'chat B marker'], [b, 'chat B marker', 'chat A marker']] as const) {
      const events = await readRecentEvents(key.session_id, 20);
      const tools = events.filter(event => event.kind === 'tool_call');
      expect(tools).toHaveLength(1);
      expect(tools[0]).toMatchObject({ call: { attribution: 'gemini_session_capability', attributionMethod: 'gemini_session_capability',
        conversationId: key.conversation_id, requestId: null } });
      const recorded = JSON.stringify(events);
      expect(recorded).toContain(own); expect(recorded).not.toContain(foreign); expect(recorded).not.toContain(key.session_key);
    }
  });

  it('lets code-mode children inherit the validated caller without redundant routing arguments', async () => {
    const result = await call(a, 'exec', { code: 'const result = await tools.read({ paths: ["/work/a/marker.txt"] }); text(result);' });
    expect(result.result.isError).not.toBe(true); expect(text(result)).toContain('chat A marker');
    const events = await readRecentEvents(a.session_id, 20);
    expect(events.filter(event => event.kind === 'tool_call').map(event => event.call.tool).sort()).toEqual(['exec', 'read']);
    expect(events.filter(event => event.kind === 'tool_call').every(event => event.call.attributionMethod === 'gemini_session_capability')).toBe(true);
  });

  it('records real patches and later calls in the observed Gemini question turn without inventing request proof', async () => {
    const turnId = 'gemini-question-0000000000000001';
    const at = Date.now() - 10;
    const entry = await input.enqueueInput({ id: randomUUID(), sessionId: a.session_id, text: 'Write the scratch note and keep working.',
      mode: 'auto', dueAt: 0, model: null, reasoningEffort: null });
    const owner = '19:exact-source-document:0', browser = 'geminibrowseraaaa1111';
    expect(await input.claimBrowserInput(entry.id, owner, CHAT_A, true, browser)).not.toBeNull();
    const custody = await input.prepareGeminiInputClaim(entry.id, owner, CHAT_A, browser);
    expect(custody).not.toBeNull(); a = await prepareGeminiInputBinding(CHAT_A, a.session_id, custody!.input);
    expect(await input.authorizeBrowserInput(entry.id, owner, CHAT_A)).toBe(true);
    expect(await input.acknowledgeBrowserInput(entry.id, owner, CHAT_A, turnId)).toBe(true);
    const observed = await recordChatObservations(CHAT_A, [
      { kind: 'turn_start', time: at + 1, turnId }
    ]);
    expect(observed.sessionId).toBe(a.session_id);
    const patch = '*** Begin Patch\n*** Add File: /work/a/generated.txt\n+real Gemini patch\n*** End Patch';
    const changed = await call(a, 'apply_patch', { patch });
    expect(changed.result.isError, text(changed)).not.toBe(true);
    expect(await fs.readFile(path.join(directory, 'work/a/generated.txt'), 'utf8')).toBe('real Gemini patch\n');
    // Several subsequent calls preserve the observed turn; their RPC id remains 1.
    for (let step = 0; step < 4; step++) {
      expect(text(await call(a, 'read', { paths: ['/work/a/generated.txt'] }))).toContain('real Gemini patch');
    }
    const events = await readRecentEvents(a.session_id, 30);
    const calls = events.filter(event => event.kind === 'tool_call');
    expect(calls).toHaveLength(5);
    for (const event of calls) expect(event).toMatchObject({ turnId, call: { requestId: null,
      attributionMethod: 'gemini_session_capability', conversationId: CHAT_A } });
    const patchCall = calls.find(event => event.call.tool === 'apply_patch');
    expect(patchCall?.call.changes?.[0]).toMatchObject({ path: '/work/a/generated.txt' });
    expect(JSON.stringify(events)).not.toContain(a.session_key);
    expect(await turnHasMcpCall(a.session_id, CHAT_A, turnId)).toBe(true);
    expect(await questionHasMcpCall(a.session_id, CHAT_A, turnId)).toBe(true);
    expect(await conversationHasMcpCallSince(a.session_id, CHAT_A, at, turnId)).toBe(true);
    expect((await readRecentEvents(b.session_id, 20)).some(event => event.kind === 'tool_call')).toBe(false);
  });

  it('keeps the existing live capability and exact-chat Block/Trust guards', async () => {
    context.caps.read = false;
    // Publish while live, then revoke to exercise a client with a cached schema.
    context.caps.read = true; await rpc('tools/list', {}); context.caps.read = false;
    const revoked = text(await call(a, 'read', { paths: ['/work/a/marker.txt'] }));
    expect(revoked).toContain('Read files permission'); expect(revoked).not.toContain('chat A marker');
    context.caps.read = true;
    setChatBlocked(CHAT_A, true);
    expect(text(await call(a, 'read', { paths: ['/work/a/marker.txt'] }))).toContain('CHAT_BLOCKED');
    expect(text(await call(b, 'read', { paths: ['/work/b/marker.txt'] }))).toContain('chat B marker');
    setChatBlocked(CHAT_A, false); getConfig().multiAgent.strictChatAllowlist = true;
    expect(text(await call(a, 'read', { paths: ['/work/a/marker.txt'] }))).toContain('CHAT_NOT_TRUSTED');
    await setChatTrusted(CHAT_A, true);
    expect(text(await call(a, 'read', { paths: ['/work/a/marker.txt'] }))).toContain('chat A marker');
  });

  it('refuses revoked nested parent evidence before entering the requested handler', async () => {
    const proof = await authenticateGeminiBinding(routing(a));
    const parent = { startedAt: Date.now(), transportKey: null, agent: null, outcome: null, evidence: emptyEvidence(),
      caller: { transportKey: null, requestId: null, conversationId: CHAT_A, sessionId: a.session_id, geminiBinding: proof } };
    await revokeGeminiBinding(CHAT_A);
    const handler = vi.fn(async () => ok(JSON.stringify({ owner: currentCaller().sessionId })));
    const result = await dispatch('read', { paths: ['/work/a/marker.txt'] }, null, null, 'core', handler, parent);
    expect(result.isError).toBe(true); expect(handler).not.toHaveBeenCalled();
  });

  it('runs the original command engine and prevents another chat polling its process id', async () => {
    const started = await call(a, 'exec_command', { cmd: 'node slow.cjs', workdir: '/work/a', yield_time_ms: 10, tty: false });
    expect(started.result?.isError, text(started)).not.toBe(true);
    const processId = started.result.structuredContent.session_id as number;
    expect(typeof processId, JSON.stringify(started)).toBe('number');
    expect(execOwner(processId)).toBe(a.session_id);
    const foreign = await call(b, 'write_stdin', { session_id: processId, chars: '', yield_time_ms: 1 });
    expect(foreign.result.isError).toBe(true); expect(text(foreign)).toContain('different');
    const own = await call(a, 'write_stdin', { session_id: processId, chars: '', yield_time_ms: 3000 });
    expect(own.result.isError, text(own)).not.toBe(true); expect(text(own)).toContain('A finished');
    expect(execOwner(processId)).toBe(a.session_id);
    expect(await fs.readFile(path.join(directory, 'work/a/marker.txt'), 'utf8')).toBe('chat A marker');
  });
});
