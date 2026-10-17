import { promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { makeTempDir, removeTempDir } from './helpers.js';

const secrets = vi.hoisted(() => new Map<string, string>());
vi.mock('../src/main/secrets.js', () => ({
  getSecret: vi.fn(async (key: string) => secrets.get(key) ?? null),
  setSecret: vi.fn(async (key: string, value: string) => { secrets.set(key, value); }),
  clearSecret: vi.fn(async (key: string) => { secrets.delete(key); })
}));
vi.mock('electron', () => ({ clipboard: { readText: () => '', writeText: () => undefined }, shell: { openExternal: async () => undefined } }));

const { initConfigPath, getConfig, effectiveCapabilities } = await import('../src/main/config.js');
const { initDurableStore, flushDurable, resetDurableForTests } = await import('../src/main/durable.js');
const { createSession, initSessionStore, flushSessions, readEvents, resetSessionStoreForTests } = await import('../src/main/session/store.js');
const { flushRecorder, resetRecorderForTests } = await import('../src/main/session/recorder.js');
const { initGeminiBindings, ensureGeminiBinding, authenticateGeminiBinding, revokeGeminiBinding, resetGeminiBindingsForTests } = await import('../src/main/gemini/bindings.js');
const { startMcpServer } = await import('../src/main/mcp/server.js');
const { pluginManager } = await import('../src/main/plugins/manager.js');
const { invokePluginTool } = await import('../src/main/mcp/tools-plugins.js');
const { emptyEvidence } = await import('../src/main/mcp/call-context.js');
const { lastToolCallAt } = await import('../src/main/mcp/kernel.js');
const { setChatBlocked, resetBlockedChatsForTests } = await import('../src/main/session/blocked-chats.js');
const { setChatTrusted, resetTrustedChatsForTests } = await import('../src/main/session/trusted-chats.js');

const CHAT = '3333333333333333';
const FOREIGN = '4444444444444444';
const PRIVATE = 'synthetic-plugin-private-credential-marker';
let directory: string, fixture: string, audit: string;
let endpoint: Awaited<ReturnType<typeof startMcpServer>>;
let binding: Awaited<ReturnType<typeof ensureGeminiBinding>>;
const sdk = pathToFileURL(path.resolve('node_modules/@modelcontextprotocol/server/dist/index.mjs')).href;
const stdio = pathToFileURL(path.resolve('node_modules/@modelcontextprotocol/server/dist/stdio.mjs')).href;
const zod = pathToFileURL(path.resolve('node_modules/zod/index.js')).href;

// Real SDK server: its strict upstream schema rejects invalid calls before this handler runs.
const source = (name = 'fixture_echo') => `import {McpServer} from ${JSON.stringify(sdk)};
import {StdioServerTransport} from ${JSON.stringify(stdio)};
import {z} from ${JSON.stringify(zod)}; import {appendFile} from 'node:fs/promises';
const server=new McpServer({name:'Gemini plugin bridge fixture',version:'1'},{capabilities:{tools:{}}});
server.registerTool(${JSON.stringify(name)},{description:'Echo a bounded fixture value',inputSchema:z.object({value:z.string().min(1)}).strict(),annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}},async args=>{
await appendFile(process.argv[2],JSON.stringify(args)+'\\n');
return {content:[{type:'text',text:args.value+' '+(process.env.TEST_SECRET||'')},{type:'resource_link',uri:'https://example.com/fixture',name:'fixture'}],structuredContent:{value:args.value},_meta:{upstream:true}};
}); await server.connect(new StdioServerTransport());`;

async function rpc(method: string, params: unknown): Promise<any> {
  const url = new URL(endpoint.url), body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'content-length': Buffer.byteLength(body) } }, response => {
      const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try { resolve(JSON.parse(raw.startsWith('{') ? raw : [...raw.matchAll(/^data:\s*(.*)$/gm)].at(-1)![1]!)); }
        catch (error) { reject(error); }
      });
    }); request.on('error', reject); request.end(body);
  });
}
const call = (args: Record<string, unknown>, tool = 'plugins') => rpc('tools/call', { name: tool,
  arguments: { ...args, conversation_id: binding.conversation_id, session_key: binding.session_key } });
const text = (response: any) => response.result?.content?.filter((item: any) => item.type === 'text').map((item: any) => item.text).join('\n') ?? JSON.stringify(response.error);
const calls = async () => (await fs.readFile(audit, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const install = async (entry = fixture) => (await pluginManager.install({ name: 'SDK fixture', source: { kind: 'command', command: process.execPath, args: [entry, audit] }, credentials: { TEST_SECRET: PRIVATE } })).plugins.at(-1)!;
const invoke = (value = 'hello', name = 'fixture_echo') => call({ action: 'call', name, arguments: { value } });

beforeEach(async () => {
  directory = await makeTempDir('gemini-plugin-bridge-'); fixture = path.join(directory, 'server.mjs'); audit = path.join(directory, 'calls.jsonl');
  await fs.writeFile(fixture, source()); secrets.clear();
  initConfigPath(directory); initDurableStore(directory); initSessionStore(directory); resetRecorderForTests();
  resetBlockedChatsForTests(); resetTrustedChatsForTests();
  const config = getConfig(); config.readOnly = false; config.multiAgent.enabled = false;
  config.ui.chatProvider = 'gemini'; config.multiAgent.strictChatAllowlistByProvider = undefined;
  config.multiAgent.allowUnattributedCalls = false; config.multiAgent.strictChatAllowlist = false; config.sessions.record = true;
  await initGeminiBindings(directory); await createSession({ conversationId: CHAT }); await createSession({ conversationId: FOREIGN });
  binding = await ensureGeminiBinding(CHAT); await pluginManager.initialize(directory);
  endpoint = await startMcpServer(() => ({ roots: [], caps: effectiveCapabilities(getConfig()), readOnly: getConfig().readOnly, sessionTools: false, agentTools: false }));
});
afterEach(async () => {
  vi.restoreAllMocks(); await endpoint?.stop(); await pluginManager.close();
  await flushRecorder(); await flushSessions(); await flushDurable(); await resetGeminiBindingsForTests();
  resetRecorderForTests(); resetSessionStoreForTests(); resetDurableForTests(); resetBlockedChatsForTests(); resetTrustedChatsForTests();
  await removeTempDir(directory);
});

it('discovers a real installed stdio MCP through one native Core bridge and records the exact inherited session', async () => {
  await install();
  const declared = (await rpc('tools/list', {})).result.tools;
  expect(declared.some((tool: any) => tool.name === 'fixture_echo')).toBe(false);
  expect(declared.find((tool: any) => tool.name === 'plugins')).toMatchObject({ title: 'External MCP plugins', inputSchema: { additionalProperties: false, required: expect.arrayContaining(['action', 'conversation_id', 'session_key']) } });
  const catalog = JSON.parse(text(await call({ action: 'list' })));
  expect(catalog).toMatchObject({ total: 1, tools: [{ name: 'fixture_echo', inputSchema: { additionalProperties: false, required: ['value'] } }] });
  expect(JSON.parse(text(await call({ action: 'list', query: 'not present' }))).tools).toEqual([]);
  const result = await invoke('own session'); expect(result.result.isError).not.toBe(true);
  expect(result.result.structuredContent).toEqual({ value: 'own session' });
  expect(result.result._meta).toEqual({ upstream: true });
  expect(result.result.content).toContainEqual({ type: 'resource_link', uri: 'https://example.com/fixture', name: 'fixture' });
  expect(text(result)).toContain('[redacted]'); expect(text(result)).not.toContain(PRIVATE);
  expect(await calls()).toEqual([{ value: 'own session' }]);
  expect(lastToolCallAt('core')).not.toBeNull();
  expect(lastToolCallAt('plugins')).toBeNull();
  await flushRecorder();
  const recorded = (await readEvents(binding.session_id)).filter(event => event.kind === 'tool_call');
  expect(recorded.map(event => event.call.tool)).toEqual(['plugins', 'plugins', 'fixture_echo', 'plugins']);
  expect(recorded.every(event => event.call.conversationId === CHAT && event.call.requestId === null && event.call.attributionMethod === 'gemini_session_capability')).toBe(true);
  expect(recorded.find(event => event.call.tool === 'fixture_echo')?.call.nested).toBe(true);
  expect(JSON.stringify(recorded)).not.toContain(binding.session_key); expect(JSON.stringify(recorded)).not.toContain(PRIVATE);
  const foreign = await ensureGeminiBinding(FOREIGN);
  expect((await readEvents(foreign.session_id)).some(event => event.kind === 'tool_call')).toBe(false);
});

it('enforces strict bridge and upstream schemas without invoking the upstream handler', async () => {
  await install();
  for (const args of [{ action: 'call', name: 'fixture_echo', args: { value: 'wrong field' } },
    { action: 'call', name: 'fixture_echo' }, { action: 'list', name: 'fixture_echo' },
    { action: 'call', name: 'fixture_echo', arguments: { value: 8 } },
    { action: 'call', name: 'fixture_echo', arguments: { value: 'no extra', extra: true } }]) {
    const result = await call(args); expect(result.error ?? result.result?.isError).toBeTruthy();
  }
  expect(await calls()).toEqual([]);
  expect(pluginManager.snapshot().plugins[0]?.status).toBe('ready');
  expect((await invoke('still valid')).result.isError).not.toBe(true);
});

it('refuses cached calls after tool disable, name collision, plugin disable and uninstall', async () => {
  const first = await install(); await call({ action: 'list' });
  await pluginManager.setToolEnabled(first.id, 'fixture_echo', false);
  expect(text(await invoke())).toContain('PLUGIN_DISABLED');
  await pluginManager.setToolEnabled(first.id, 'fixture_echo', true);
  const duplicate = await install();
  expect(JSON.parse(text(await call({ action: 'list' }))).tools).toEqual([]);
  expect(text(await invoke())).toContain('PLUGIN_NOT_EXPOSED');
  await pluginManager.setEnabled(duplicate.id, false);
  expect(text(await invoke())).toContain('PLUGIN_NOT_EXPOSED');
  await pluginManager.uninstall(duplicate.id); await pluginManager.setEnabled(first.id, false);
  expect(text(await invoke())).toContain('PLUGIN_DISABLED');
  await pluginManager.uninstall(first.id);
  expect(text(await invoke())).toContain('UNKNOWN_TOOL');
  expect((await rpc('tools/list', {})).result.tools.some((tool: any) => tool.name === 'plugins')).toBe(true);
  expect(await calls()).toEqual([]);
});

it('keeps discovery stable before installation and during read-only while refusing execution', async () => {
  expect((await rpc('tools/list', {})).result.tools.some((tool: any) => tool.name === 'plugins')).toBe(true);
  expect(JSON.parse(text(await call({ action: 'list' })))).toMatchObject({ tools: [], total: 0 });
  await endpoint.stop(); await install(); getConfig().readOnly = true;
  endpoint = await startMcpServer(() => ({ roots: [], caps: effectiveCapabilities(getConfig()), readOnly: getConfig().readOnly, sessionTools: false, agentTools: false }));
  expect((await rpc('tools/list', {})).result.tools.some((tool: any) => tool.name === 'plugins')).toBe(true);
  getConfig().readOnly = false;
  expect((await rpc('tools/list', {})).result.tools.some((tool: any) => tool.name === 'plugins')).toBe(true);
  getConfig().readOnly = true;
  expect((await rpc('tools/list', {})).result.tools.some((tool: any) => tool.name === 'plugins')).toBe(true);
  expect(text(await invoke())).toContain('TOOL_DISABLED'); expect(await calls()).toEqual([]);
});

it('preserves Block, Trust, revoked capability and superseded attachment fences', async () => {
  await install(); await call({ action: 'list' });
  setChatBlocked(CHAT, true); expect(text(await invoke())).toContain('CHAT_BLOCKED'); setChatBlocked(CHAT, false);
  getConfig().multiAgent.strictChatAllowlist = true;
  expect(text(await invoke())).toContain('CHAT_NOT_TRUSTED'); await setChatTrusted(CHAT, true);
  expect((await invoke('trusted')).result.isError).not.toBe(true);
  await revokeGeminiBinding(CHAT); expect(text(await invoke())).toContain('GEMINI_SESSION_AUTHORIZATION_EXPIRED');
  binding = await ensureGeminiBinding(CHAT);
  await createSession({ conversationId: CHAT });
  expect(text(await invoke())).toContain('GEMINI_SESSION_NOT_ATTACHED');
  expect(await calls()).toEqual([{ value: 'trusted' }]);
});

it('composes the advertised bridge through Core exec with one owner and redacts both wrapper recordings', async () => {
  await install(); await rpc('tools/list', {});
  const result = await call({ code: `const result=await tools.plugins({action:"call",name:"fixture_echo",arguments:{value:${JSON.stringify(PRIVATE)}}}); text(result);` }, 'exec');
  expect(result.result.isError).not.toBe(true); expect(text(result)).toContain('[redacted]'); expect(text(result)).not.toContain(PRIVATE);
  const recorded = (await readEvents(binding.session_id)).filter(event => event.kind === 'tool_call');
  expect(recorded.map(event => event.call.tool)).toEqual(['fixture_echo', 'plugins', 'exec']);
  expect(recorded.every(event => event.call.conversationId === CHAT && event.call.attributionMethod === 'gemini_session_capability')).toBe(true);
  expect(JSON.stringify(recorded)).not.toContain(PRIVATE); expect(JSON.stringify(recorded)).not.toContain(binding.session_key);
});

it('rechecks an admitted parent capability before plugin child dispatch and preserves an upstream tool named exec', async () => {
  await fs.writeFile(fixture, source('exec')); await install();
  expect((await invoke('upstream exec', 'exec')).result.isError).not.toBe(true);
  const proof = await authenticateGeminiBinding({ conversation_id: CHAT, session_key: binding.session_key });
  const parent = { startedAt: Date.now(), transportKey: null, agent: null, outcome: null, evidence: emptyEvidence(),
    caller: { transportKey: null, requestId: null, conversationId: CHAT, sessionId: binding.session_id, geminiBinding: proof } };
  setChatBlocked(CHAT, true);
  expect((await invokePluginTool('exec', { value: 'blocked child' }, parent)).isError).toBe(true);
  setChatBlocked(CHAT, false); getConfig().multiAgent.strictChatAllowlist = true;
  expect((await invokePluginTool('exec', { value: 'untrusted child' }, parent)).isError).toBe(true);
  getConfig().multiAgent.strictChatAllowlist = false; getConfig().readOnly = true;
  expect((await invokePluginTool('exec', { value: 'read-only child' }, parent)).isError).toBe(true);
  getConfig().readOnly = false;
  await revokeGeminiBinding(CHAT);
  expect((await invokePluginTool('exec', { value: 'revoked child' }, parent)).isError).toBe(true);
  expect(await calls()).toEqual([{ value: 'upstream exec' }]);
});
