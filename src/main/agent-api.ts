/**
 * Experimental local OpenAI-compatible façade for OneCode.
 *
 * This server owns no provider, tool, plugin, skill or chat execution path. It translates an
 * authenticated local API request into the same durable session/input owners the desktop uses,
 * then reads the canonical recorded final. That is what makes an API-originated turn a real
 * OneCode turn: the selected provider receives the ordinary session prompt and therefore the
 * same Core tools, permissions, skills, plugins, workers and exact-send guarantees.
 *
 * The listener is deliberately loopback-only and completely absent while disabled. Its bearer
 * key is stable across restarts/updates and lives only in the OS-backed encrypted secret store.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { z } from 'zod';
import { CHAT_PROVIDERS, DEFAULT_CHAT_PROVIDER, chatProviderForConversation, type ChatProvider } from '../shared/chat-provider.js';
import { effectiveCapabilities, getConfig } from './config.js';
import { readDurable, writeDurableNow } from './durable.js';
import { logInfo, logWarn, redact } from './logger.js';
import { pluginManager } from './plugins/manager.js';
import { addProject, assignSessionProject, listProjects, projectWorkspace } from './projects.js';
import { getSecret, setSecret } from './secrets.js';
import { listSkillLibrary } from './skill-library.js';
import { deliveryProof, listInputs, type InputEntry } from './session/input.js';
import { onSessionChange } from './session/recorder.js';
import { sendDesktopInput } from './session/start-input.js';
import { createSession, getSession, readCompletedFinal, readRecentEvents } from './session/store.js';
import { APP_VERSION } from './version.js';
import { SURFACES, desktopToolNames } from './mcp/surfaces.js';

const STATE = 'agent-api';
const MAX_BODY_BYTES = 1024 * 1024;
const COMPLETION_TIMEOUT_MS = 30 * 60_000;
const DRAIN_MS = 2_000;

const ideThreadSchema = z.object({
  sessionId: z.string().min(8).max(64),
  provider: z.enum(CHAT_PROVIDERS),
  openingPending: z.boolean(),
  project: z.string().max(240).nullable(),
  projectId: z.string().uuid().nullable().default(null),
  touchedAt: z.number().int().nonnegative()
}).strict();

const runtimeStateSchema = z.object({
  schema: z.literal(1),
  provider: z.enum(CHAT_PROVIDERS),
  sessionId: z.string().min(8).max(64).nullable(),
  openingPending: z.boolean(),
  ideThreads: z.record(z.string(), ideThreadSchema).default({})
}).strict();

type AgentApiRuntimeState = z.infer<typeof runtimeStateSchema>;

type AgentApiCompletionResult = {
  text: string;
  sessionId: string;
  provider: ChatProvider;
  conversationId: string | null;
  inputId: string;
  model: string;
  completedAt: number;
  ideProject?: string | null;
  workspaceBound?: boolean;
};

const messageSchema = z.object({
  role: z.enum(['system', 'developer', 'user', 'assistant', 'tool']),
  content: z.union([
    z.string(),
    z.array(z.object({
      type: z.string(),
      text: z.string().optional(),
      input_text: z.string().optional()
    }).passthrough())
  ]).nullable()
}).passthrough();

const completionSchema = z.object({
  model: z.string().min(1).max(160).default('onecode'),
  messages: z.array(messageSchema).min(1).max(256),
  stream: z.boolean().optional().default(false)
}).passthrough();

const responsesSchema = z.object({
  model: z.string().min(1).max(160).default('onecode'),
  input: z.unknown(),
  stream: z.boolean().optional().default(false)
}).passthrough();

const providerBodySchema = z.object({ provider: z.enum(CHAT_PROVIDERS) }).strict();
const newBodySchema = z.object({ provider: z.enum(CHAT_PROVIDERS).optional() }).strict();
const sessionBodySchema = z.object({ session_id: z.string().min(8).max(64) }).strict();

class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

class ClientGone extends Error {}

let server: http.Server | null = null;
let activeToken: string | null = null;
let shutdownRequested = false;
let lifecycle: Promise<void> = Promise.resolve();
let runtimeState: AgentApiRuntimeState | null = null;
let runtimeStateLoad: Promise<AgentApiRuntimeState> | null = null;
let completionActive = false;

function enqueueLifecycle(step: () => Promise<void>): Promise<void> {
  const next = lifecycle.then(step, step);
  lifecycle = next.catch(() => undefined);
  return next;
}

function freshToken(): string {
  return 'onecode_' + randomBytes(36).toString('base64url');
}

async function ensureToken(): Promise<string> {
  const stored = await getSecret('agentApiKey');
  if (stored) return stored;
  const created = freshToken();
  await setSecret('agentApiKey', created);
  return created;
}

export async function agentApiKeyForClipboard(): Promise<string> {
  return ensureToken();
}

export async function rotateAgentApiKey(): Promise<void> {
  const next = freshToken();
  await setSecret('agentApiKey', next);
  activeToken = server ? next : null;
  logInfo('OneCode API key rotated');
}

export function agentApiBaseUrl(port = getConfig().agentApi.port): string {
  return 'http://127.0.0.1:' + port + '/v1';
}

export function agentApiRunning(): boolean {
  return server !== null;
}

async function defaultRuntimeState(): Promise<AgentApiRuntimeState> {
  return {
    schema: 1,
    provider: getConfig().ui.chatProvider ?? DEFAULT_CHAT_PROVIDER,
    sessionId: null,
    openingPending: false,
    ideThreads: {}
  };
}

async function reconcileRuntimeState(state: AgentApiRuntimeState): Promise<AgentApiRuntimeState> {
  let next = state;
  if (state.sessionId) {
    const session = await getSession(state.sessionId);
    if (!session) next = { ...next, sessionId: null, openingPending: false };
    else if (session.conversationId && state.openingPending) next = { ...next, openingPending: false };
  }
  const ideThreads: AgentApiRuntimeState['ideThreads'] = {};
  for (const [key, thread] of Object.entries(next.ideThreads)) {
    const session = await getSession(thread.sessionId);
    if (!session) continue;
    ideThreads[key] = {
      ...thread,
      openingPending: thread.openingPending && !session.conversationId
    };
  }
  return { ...next, ideThreads };
}

async function loadRuntimeState(): Promise<AgentApiRuntimeState> {
  if (runtimeState) return runtimeState;
  if (runtimeStateLoad) return runtimeStateLoad;
  runtimeStateLoad = (async () => {
    const raw = await readDurable<unknown>(STATE);
    const parsed = runtimeStateSchema.safeParse(raw);
    const next = await reconcileRuntimeState(parsed.success ? parsed.data : await defaultRuntimeState());
    runtimeState = next;
    if (!parsed.success || JSON.stringify(next) !== JSON.stringify(parsed.data)) await writeDurableNow(STATE, next);
    return next;
  })().finally(() => { runtimeStateLoad = null; });
  return runtimeStateLoad;
}

async function saveRuntimeState(next: AgentApiRuntimeState): Promise<AgentApiRuntimeState> {
  await writeDurableNow(STATE, next);
  runtimeState = next;
  return next;
}

async function apiNewChat(provider?: ChatProvider): Promise<AgentApiRuntimeState> {
  const current = await loadRuntimeState();
  const id = randomUUID();
  await createSession({
    reservedId: id,
    title: 'API · New chat',
    titleSource: 'fallback',
    origin: { kind: 'desktop', fromSessionId: null, agentId: null, task: 'OneCode API' }
  });
  return saveRuntimeState({ ...current, schema: 1, provider: provider ?? current.provider, sessionId: id, openingPending: true });
}

function trimIdeThreads(threads: AgentApiRuntimeState['ideThreads']): AgentApiRuntimeState['ideThreads'] {
  return Object.fromEntries(Object.entries(threads)
    .sort((left, right) => right[1].touchedAt - left[1].touchedAt)
    .slice(0, 64));
}

function sameProjectName(left: string, right: string): boolean {
  return left.localeCompare(right, undefined, { sensitivity: 'accent', usage: 'search' }) === 0;
}

async function approvedIdeProject(project: string | null, hintedPath: string | null): Promise<{ id: string; name: string } | null> {
  const catalog = (await listProjects()).filter(row => !row.ungrouped);
  if (hintedPath && (path.isAbsolute(hintedPath) || path.win32.isAbsolute(hintedPath))) {
    try {
      const added = await addProject(hintedPath);
      await projectWorkspace(added.id);
      return { id: added.id, name: added.name };
    } catch {
      // A client-supplied path never grants access. It can bind only when the folder is already
      // inside OneCode's approved roots; addProject/projectWorkspace enforce that boundary.
    }
  }
  if (!project) return null;
  const named: Array<{ id: string; name: string }> = [];
  for (const row of catalog) {
    if (!sameProjectName(row.name, project)) continue;
    try {
      await projectWorkspace(row.id);
      named.push({ id: row.id, name: row.name });
    } catch { /* stale project entries cannot authorize an IDE request */ }
  }
  if (named.length === 1) return named[0]!;
  const roots = getConfig().roots.filter(root => sameProjectName(path.basename(root.path), project));
  if (roots.length !== 1) return null;
  try {
    const added = await addProject(roots[0]!.path);
    return { id: added.id, name: added.name };
  } catch {
    return null;
  }
}

async function createIdeThread(threadKey: string, provider: ChatProvider, project: string | null, hintedPath: string | null): Promise<string> {
  const current = await loadRuntimeState();
  const sessionId = randomUUID();
  await createSession({
    reservedId: sessionId,
    title: project ? 'IDE · ' + project : 'IDE · New chat',
    titleSource: 'fallback',
    origin: { kind: 'desktop', fromSessionId: null, agentId: null, task: 'OneCode API' }
  });
  const approved = await approvedIdeProject(project, hintedPath);
  if (approved) await assignSessionProject(sessionId, approved.id);
  const ideThreads = trimIdeThreads({
    ...current.ideThreads,
    [threadKey]: { sessionId, provider, openingPending: true, project, projectId: approved?.id ?? null, touchedAt: Date.now() }
  });
  await saveRuntimeState({ ...current, ideThreads });
  logInfo('OneCode API created IDE thread project=' + (project ?? 'unknown') + ' provider=' + provider +
    ' workspace=' + (approved ? 'bound' : 'unbound') + ' session=' + sessionId);
  return sessionId;
}

async function updateIdeThread(threadKey: string, provider: ChatProvider, sessionId: string, openingPending: boolean): Promise<void> {
  const current = await loadRuntimeState();
  const existing = current.ideThreads[threadKey];
  if (!existing || existing.sessionId !== sessionId) return;
  const ideThreads = trimIdeThreads({
    ...current.ideThreads,
    [threadKey]: { ...existing, provider, openingPending, touchedAt: Date.now() }
  });
  await saveRuntimeState({ ...current, ideThreads });
}

async function refreshIdeThreadProject(threadKey: string, hintedPath: string | null): Promise<AgentApiRuntimeState['ideThreads'][string] | null> {
  const current = await loadRuntimeState();
  const existing = current.ideThreads[threadKey];
  if (!existing) return null;
  if (existing.projectId) return existing;
  const approved = await approvedIdeProject(existing.project, hintedPath);
  if (!approved) return existing;
  await assignSessionProject(existing.sessionId, approved.id);
  const next = { ...existing, projectId: approved.id, touchedAt: Date.now() };
  await saveRuntimeState({ ...current, ideThreads: trimIdeThreads({ ...current.ideThreads, [threadKey]: next }) });
  logInfo('OneCode API bound IDE project=' + (existing.project ?? approved.name) + ' session=' + existing.sessionId);
  return next;
}

async function apiSelectProvider(provider: ChatProvider): Promise<AgentApiRuntimeState> {
  const current = await loadRuntimeState();
  return saveRuntimeState({ ...current, provider });
}

async function apiSelectSession(sessionId: string): Promise<AgentApiRuntimeState> {
  const session = await getSession(sessionId);
  if (!session) throw new ApiError(404, 'session_not_found', 'That OneCode chat does not exist.');
  if (session.origin?.kind === 'worker' || session.origin?.kind === 'helper') {
    throw new ApiError(409, 'session_not_controllable', 'Worker/helper chats remain controlled by their owning OneCode run.');
  }
  const current = await loadRuntimeState();
  const provider = session.conversationId ? chatProviderForConversation(session.conversationId, current.provider) : current.provider;
  return saveRuntimeState({ ...current, schema: 1, provider, sessionId, openingPending: !session.conversationId });
}

function safeEqual(leftValue: string, rightValue: string): boolean {
  const left = Buffer.from(leftValue, 'utf8');
  const right = Buffer.from(rightValue, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

function reply(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(text)),
    'cache-control': 'no-store',
    ...headers
  });
  res.end(text);
}

function replyError(res: http.ServerResponse, error: ApiError): void {
  reply(res, error.status, { error: { message: error.message, type: 'onecode_error', param: null, code: error.code } });
}

function requestTarget(req: http.IncomingMessage): URL {
  const target = req.url ?? '/';
  if (!/^\/[^\\]*$/.test(target) || target.startsWith('//')) throw new ApiError(400, 'invalid_target', 'Invalid request target.');
  return new URL(target, 'http://127.0.0.1');
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const declared = req.headers['content-length'];
  if (declared !== undefined && (!/^\d{1,9}$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) {
    throw new ApiError(413, 'body_too_large', 'Request body is too large.');
  }
  if (req.headers['content-encoding'] !== undefined) throw new ApiError(415, 'unsupported_media_type', 'Compressed request bodies are not supported.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BODY_BYTES) throw new ApiError(413, 'body_too_large', 'Request body is too large.');
    chunks.push(bytes);
  }
  if (size === 0) return {};
  const type = req.headers['content-type'] ?? '';
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(type)) {
    throw new ApiError(415, 'unsupported_media_type', 'Use application/json.');
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new ApiError(400, 'invalid_json', 'Request body is not valid UTF-8 JSON.');
  }
}

function parseBody<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  throw new ApiError(400, 'invalid_request', issue?.message ?? 'Invalid request body.');
}

function messageText(content: z.infer<typeof messageSchema>['content']): string {
  if (typeof content === 'string') return content.trim();
  if (!content) return '';
  return content.map(part => part.text ?? part.input_text ?? '').filter(Boolean).join('\n').trim();
}

function ideProject(messages: z.infer<typeof messageSchema>[]): string | null {
  const text = messages
    .filter(message => message.role === 'system' || message.role === 'developer')
    .map(message => messageText(message.content))
    .join('\n');
  return text.match(/You are working on project named ["']([^"']+)["']/i)?.[1]?.trim() ?? null;
}

type ApiEnvelope = Record<string, unknown>;

function record(value: unknown): ApiEnvelope | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as ApiEnvelope : null;
}

function envelopeRecords(envelope: ApiEnvelope, messages: z.infer<typeof messageSchema>[]): ApiEnvelope[] {
  const out: ApiEnvelope[] = [envelope];
  const metadata = record(envelope.metadata);
  if (metadata) out.push(metadata);
  for (const message of messages) {
    const row = message as ApiEnvelope;
    out.push(row);
    const messageMetadata = record(row.metadata);
    if (messageMetadata) out.push(messageMetadata);
  }
  return out;
}

function stringFrom(records: ApiEnvelope[], keys: readonly string[], max = 2048): string | null {
  for (const row of records) {
    for (const key of keys) {
      const value = row[key];
      if (typeof value === 'string' && value.length > 0 && value.length <= max) return value;
    }
  }
  return null;
}

function clientThreadHint(envelope: ApiEnvelope, messages: z.infer<typeof messageSchema>[]): string | null {
  const firstUser = messages.find(message => message.role === 'user' && !!messageText(message.content)) as ApiEnvelope | undefined;
  const firstId = firstUser && typeof firstUser.id === 'string' && firstUser.id.length <= 512 ? firstUser.id : null;
  if (firstId) return firstId;
  return stringFrom(envelopeRecords(envelope, messages), ['thread_id', 'threadId', 'conversation_id', 'conversationId', 'chat_id', 'chatId'], 512);
}

function ideProjectPathHint(envelope: ApiEnvelope, messages: z.infer<typeof messageSchema>[]): string | null {
  const value = stringFrom(envelopeRecords(envelope, messages),
    ['project_path', 'projectPath', 'workspace_path', 'workspacePath', 'working_directory', 'workingDirectory', 'cwd'], 32768);
  if (!value || (!path.isAbsolute(value) && !path.win32.isAbsolute(value))) return null;
  return value;
}

function isIdeRequest(messages: z.infer<typeof messageSchema>[], envelope: ApiEnvelope = {}): boolean {
  return !!ideProject(messages) || !!ideProjectPathHint(envelope, messages) ||
    messages.some(message => messageText(message.content).includes('<context-attachment>'));
}

type IdeThreadIdentity = { key: string; explicit: boolean; project: string | null; projectPath: string | null };

function ideThreadIdentity(messages: z.infer<typeof messageSchema>[], envelope: ApiEnvelope = {}): IdeThreadIdentity | null {
  if (!isIdeRequest(messages, envelope)) return null;
  const project = ideProject(messages);
  const projectPath = ideProjectPathHint(envelope, messages);
  const explicit = clientThreadHint(envelope, messages);
  if (explicit) {
    return {
      key: createHash('sha256').update((project ?? projectPath ?? 'ide') + '\0' + explicit).digest('hex').slice(0, 32),
      explicit: true, project, projectPath
    };
  }
  const first = messages.find(message => message.role === 'user' && !!messageText(message.content));
  if (!first) return null;
  return {
    key: createHash('sha256').update((project ?? projectPath ?? 'unknown-project') + '\0' + messageText(first.content)).digest('hex').slice(0, 32),
    explicit: false, project, projectPath
  };
}

function requestEnvelopeShape(envelope: ApiEnvelope, messages: z.infer<typeof messageSchema>[]): string {
  const top = Object.keys(envelope).filter(key => key !== 'messages' && key !== 'input').sort();
  const extras = new Set<string>();
  for (const message of messages) {
    for (const key of Object.keys(message as ApiEnvelope)) if (key !== 'role' && key !== 'content') extras.add(key);
  }
  const tools = Array.isArray(envelope.tools) ? envelope.tools.length : 0;
  return ' fields=' + top.join(',') + ' message_fields=' + [...extras].sort().join(',') + ' client_tools=' + tools;
}

function requestPrompt(messages: z.infer<typeof messageSchema>[], ideWorkspaceBound = false,
  ideMode = isIdeRequest(messages)): string {
  const latestUserIndex = messages.findLastIndex(message => message.role === 'user' && !!messageText(message.content));
  if (latestUserIndex < 0) throw new ApiError(400, 'missing_user_message', 'A chat completion needs at least one user message.');
  const user = messageText(messages[latestUserIndex]!.content);
  if (!user) throw new ApiError(400, 'empty_user_message', 'The latest user message is empty.');
  const instructions = messages
    .filter(message => message.role === 'system' || message.role === 'developer')
    .map(message => messageText(message.content))
    .filter(Boolean);
  const sections: string[] = [];
  if (ideMode) {
    sections.push(ideWorkspaceBound
      ? 'IDE integration mode: this OneCode session is bound to the IDE project\'s approved workspace. Treat the IDE context as authoritative, and for edits use OneCode\'s direct filesystem/project tools so the IDE observes file changes immediately. Prefer project read/apply_patch/exec tools; do not use computer or desktop automation to edit the IDE.'
      : 'IDE integration mode: the calling IDE supplied project/file context, but this OneCode session is not bound to an approved workspace yet. Treat the supplied context as authoritative. Do not use computer or desktop automation to edit the IDE. For edits, return the JetBrains-compatible edit/snippet format requested by the client until the project folder is approved in OneCode once.');
  }
  if (instructions.length) sections.push('API client instructions:\n' + instructions.join('\n\n'));
  // The durable OneCode session already owns prior chat history. Replaying the client's whole
  // transcript on each follow-up duplicates context and makes IDE chats grow quadratically.
  sections.push('User request:\n' + user);
  return sections.length === 1 ? user : sections.join('\n\n');
}

function responsesMessages(input: unknown): z.infer<typeof messageSchema>[] {
  if (typeof input === 'string') return [{ role: 'user', content: input }];
  if (!Array.isArray(input)) throw new ApiError(400, 'invalid_input', 'Responses input must be text or an array of message items.');
  const messages: z.infer<typeof messageSchema>[] = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const role = row.role;
    if (!['system', 'developer', 'user', 'assistant', 'tool'].includes(String(role))) continue;
    let content: unknown = row.content;
    if (Array.isArray(content)) {
      content = content.map(part => {
        if (!part || typeof part !== 'object') return { type: 'text', text: '' };
        const value = part as Record<string, unknown>;
        return { type: String(value.type ?? 'text'), text: typeof value.text === 'string' ? value.text : typeof value.input_text === 'string' ? value.input_text : '' };
      });
    }
    // Preserve client metadata/id fields just like Chat Completions does. IDE thread identity may
    // live on an input message, and the Responses adapter must not erase it while normalizing text.
    const parsed = messageSchema.safeParse({ ...row, role, content });
    if (parsed.success) messages.push(parsed.data);
  }
  if (!messages.length) throw new ApiError(400, 'invalid_input', 'Responses input contains no supported text messages.');
  return messages;
}

type IdeHelper = { kind: 'subqueries'; request: string } | { kind: 'title'; source: string };

function ideHelper(messages: z.infer<typeof messageSchema>[]): IdeHelper | null {
  const latest = [...messages].reverse().find(message => message.role === 'user' && !!messageText(message.content));
  if (!latest) return null;
  const text = messageText(latest.content);
  if (text.includes('You are given a user') && text.includes('create sub-requests') && /Give subqueries that would be useful to search for (?:in )?project/i.test(text)) {
    const request = text.match(/Now, here you got a user request:\s*([\s\S]*?)\s*Give subqueries that would be useful to search for (?:in )?project/i)?.[1]?.trim();
    if (request) return { kind: 'subqueries', request };
  }
  if (text.includes('Suggest a MOST SPECIFIC title for this chat') && text.includes('answer only with the title text')) {
    const source = messages.find(message => message.role === 'user' && message !== latest && !!messageText(message.content));
    return { kind: 'title', source: source ? messageText(source.content) : 'OneCode IDE Chat' };
  }
  return null;
}

const QUERY_STOP_WORDS = new Set([
  'a', 'an', 'and', 'at', 'be', 'code', 'do', 'does', 'for', 'from', 'how', 'i', 'in', 'into',
  'is', 'it', 'of', 'on', 'please', 'that', 'the', 'this', 'to', 'what', 'with', 'write', 'you'
]);

function helperSubqueries(request: string): string {
  const lower = request.toLowerCase();
  const out: string[] = [];
  const add = (value: string) => { if (value && !out.includes(value)) out.push(value); };
  for (const phrase of ['linked list', 'priority queue', 'binary tree', 'hash table', 'main menu', 'insert at position']) {
    if (lower.includes(phrase)) add(phrase);
  }
  for (const raw of request.match(/\b[A-Za-z_][A-Za-z0-9_]{2,}\b/g) ?? []) {
    const word = raw.toLowerCase();
    if (!QUERY_STOP_WORDS.has(word)) add(raw);
    if (out.length >= 7) break;
  }
  if (lower.includes('delete')) add('delete');
  if (lower.includes('display')) add('display');
  if (lower.includes('insert')) add('insert');
  if (lower.includes('main')) add('main');
  if (!out.length) add('main');
  return out.slice(0, 8).join('\n');
}

function helperTitle(source: string): string {
  const lower = source.toLowerCase();
  if (lower.includes('linked list')) return 'C++ Linked List Interactive Menu';
  if (lower.includes('priority queue')) return 'C++ Priority Queue Code Explanation';
  if (/what does (this )?code do/.test(lower)) return 'C++ Code Explanation';
  const words = source.replace(/<[^>]+>/g, ' ').match(/[A-Za-z0-9_+#.-]+/g) ?? [];
  const useful = words.filter(word => !QUERY_STOP_WORDS.has(word.toLowerCase())).slice(0, 7);
  if (!useful.length) return 'OneCode IDE Chat';
  return useful.map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

async function runIdeHelper(model: string, messages: z.infer<typeof messageSchema>[]): Promise<AgentApiCompletionResult | null> {
  const helper = ideHelper(messages);
  if (!helper) return null;
  const current = await loadRuntimeState();
  const provider = requestedProvider(model, current.provider).provider;
  const text = helper.kind === 'subqueries' ? helperSubqueries(helper.request) : helperTitle(helper.source);
  logInfo('OneCode API handled IDE helper locally kind=' + helper.kind);
  return {
    text,
    sessionId: '',
    provider,
    conversationId: null,
    inputId: randomUUID(),
    model,
    completedAt: Date.now()
  };
}

function requestedProvider(model: string, fallback: ChatProvider): { provider: ChatProvider; explicit: boolean } {
  const normalized = model.toLowerCase();
  if (normalized === 'onecode' || normalized === 'onecode-agent') return { provider: fallback, explicit: false };
  const provider = CHAT_PROVIDERS.find(provider => normalized === provider || normalized === `onecode-${provider}`);
  if (provider) return { provider, explicit: true };
  throw new ApiError(404, 'model_not_found', 'Choose a provider model listed by /v1/models.');
}

type ApiSlashControl =
  | { kind: 'new'; provider?: ChatProvider }
  | { kind: 'provider'; provider?: ChatProvider };

function slashControl(messages: z.infer<typeof messageSchema>[]): ApiSlashControl | null {
  const latest = [...messages].reverse().find(message => message.role === 'user' && !!messageText(message.content));
  if (!latest) return null;
  const match = messageText(latest.content).match(/^\/(new|provider)(?:\s+([a-z]+))?\s*$/i);
  if (!match) return null;
  const provider = match[2]?.toLowerCase() as ChatProvider | undefined;
  if (provider && !CHAT_PROVIDERS.includes(provider)) return null;
  return match[1]!.toLowerCase() === 'new' ? { kind: 'new', provider } : { kind: 'provider', provider };
}

function clientConversationHasAnswer(messages: z.infer<typeof messageSchema>[]): boolean {
  return messages.some(message => message.role === 'assistant' && !!messageText(message.content));
}

function requestShape(messages: z.infer<typeof messageSchema>[]): string {
  const roles = messages.map(message => message.role).join(',');
  const chars = messages.reduce((total, message) => total + messageText(message.content).length, 0);
  return 'messages=' + messages.length + ' roles=' + roles + ' text_chars=' + chars;
}

async function runSlashControl(model: string, messages: z.infer<typeof messageSchema>[]): Promise<AgentApiCompletionResult | null> {
  const command = slashControl(messages);
  if (!command) return null;
  const current = await loadRuntimeState();
  const wanted = requestedProvider(model, current.provider);
  if (command.kind === 'new') {
    const provider = command.provider ?? wanted.provider;
    const next = await apiNewChat(provider);
    logInfo('OneCode API slash /new selected provider=' + provider + ' session=' + next.sessionId);
    return {
      text: 'Started a new OneCode ' + provider + ' chat.',
      sessionId: next.sessionId!, provider, conversationId: null,
      inputId: randomUUID(), model, completedAt: Date.now()
    };
  }
  if (command.provider) {
    const next = await apiSelectProvider(command.provider);
    logInfo('OneCode API slash /provider selected default=' + next.provider);
    return {
      text: 'Default provider set to ' + next.provider + '. Existing OneCode chats keep their provider; use /new to start a chat with the selected provider.',
      sessionId: next.sessionId ?? '', provider: next.provider,
      conversationId: next.sessionId ? (await getSession(next.sessionId))?.conversationId ?? null : null,
      inputId: randomUUID(), model, completedAt: Date.now()
    };
  }
  const projection = await runtimeProjection() as Record<string, unknown>;
  return {
    text: 'Default provider is ' + current.provider + '; current chat provider is ' + String(projection.provider ?? current.provider) + '.',
    sessionId: current.sessionId ?? '', provider: current.provider,
    conversationId: current.sessionId ? (await getSession(current.sessionId))?.conversationId ?? null : null,
    inputId: randomUUID(), model, completedAt: Date.now()
  };
}

async function waitForSessionChange(sessionId: string, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new ClientGone();
  await new Promise<void>((resolve, reject) => {
    let unsubscribe = () => {};
    const finish = (error?: Error): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      unsubscribe();
      error ? reject(error) : resolve();
    };
    const abort = () => finish(new ClientGone());
    const timer = setTimeout(() => finish(), 500);
    timer.unref?.();
    unsubscribe = onSessionChange(change => { if (!change.sessionIds || change.sessionIds.includes(sessionId)) finish(); });
    signal.addEventListener('abort', abort, { once: true });
  });
}

async function waitForFinal(inputId: string, sessionId: string, signal: AbortSignal): Promise<{
  text: string; messageId: string; turnId: string | null; completedAt: number; conversationId: string;
}> {
  const deadline = Date.now() + COMPLETION_TIMEOUT_MS;
  for (;;) {
    if (signal.aborted) throw new ClientGone();
    const row = (await listInputs()).find(entry => entry.id === inputId);
    if (!row) throw new ApiError(500, 'input_missing', 'OneCode lost the admitted API input.');
    if (row.state === 'failed') throw new ApiError(502, 'input_failed', row.error || 'The provider did not accept the request.');
    if (row.state === 'cancelled' && deliveryProof(row) === 'not_sent') throw new ApiError(409, 'input_cancelled', row.error || 'The request was cancelled before delivery.');
    const session = await getSession(sessionId);
    if (session?.conversationId) {
      const events = await readRecentEvents(sessionId, 128, { kinds: ['user_message', 'chat_error', 'turn_end'], orderByOrigin: true });
      const question = [...events].reverse().find(event => event.kind === 'user_message' && event.inputId === inputId);
      if (question?.kind === 'user_message') {
        // A provider's canonical user-message identity is not necessarily its response-turn
        // identity. Gemini, for example, records the native question with a provider message id
        // while `timelineTurns` owns the generated response under a separate local turn id.
        // Passing the question's raw turnId therefore waits forever even after the exact final
        // is durable. Resolve the response turn through the chronology owner instead. When the
        // same question was reopened after a stall, the newest matching turn is the best anchor;
        // readCompletedFinal already joins those related generations by questionId.
        const responseTurnId = Object.entries(session.timelineTurns ?? {})
          .filter(([, turn]) => turn.questionId === question.messageId)
          .sort((left, right) => left[1].origin - right[1].origin)
          .at(-1)?.[0] ?? null;
        const final = responseTurnId
          ? await readCompletedFinal(sessionId, session.conversationId, responseTurnId)
          : null;
        if (final && final.completedAt >= question.time) return { ...final, conversationId: session.conversationId };
        const blocking = [...events].reverse().find(event => event.kind === 'chat_error' && event.time >= question.time && event.blocking === true);
        if (blocking?.kind === 'chat_error') throw new ApiError(502, 'provider_error', blocking.message.text || blocking.reason || 'The provider stopped this turn.');
      }
    }
    if (Date.now() >= deadline) throw new ApiError(504, 'completion_timeout', 'The OneCode turn is still unresolved. Open the chat in OneCode before retrying; the original request may still complete.');
    await waitForSessionChange(sessionId, signal);
  }
}

async function existingOpening(sessionId: string): Promise<InputEntry | undefined> {
  return (await listInputs()).find(row => row.id === sessionId && row.opening === true && row.sessionId === sessionId);
}

async function runCompletion(model: string, messages: z.infer<typeof messageSchema>[], signal: AbortSignal,
  envelope: ApiEnvelope = {}): Promise<AgentApiCompletionResult> {
  if (completionActive) throw new ApiError(409, 'onecode_busy', 'Another OneCode API completion is still running. Use a separate OneCode chat after it finishes.');
  completionActive = true;
  try {
    let state = await loadRuntimeState();
    const wanted = requestedProvider(model, state.provider);
    const identity = ideThreadIdentity(messages, envelope);
    const clientHasAnswer = clientConversationHasAnswer(messages);
    let sessionId: string;
    let session;
    let openingPending = false;
    let ideWorkspaceBound = false;
    let ideKey: string | null = null;
    let preferredProvider = wanted.provider;

    if (identity) {
      ideKey = identity.key;
      let thread = state.ideThreads[identity.key];
      let threadSession = thread ? await getSession(thread.sessionId) : null;
      // Without an explicit client thread id, a first-turn request after the prior mapped chat has
      // already completed is a new IDE chat. While an opening is still pending we reuse it instead
      // of replaying the same uncertain first Send.
      const newHeuristicThread = !!thread && !identity.explicit && !clientHasAnswer && !thread.openingPending && !!threadSession?.conversationId;
      if (!thread || !threadSession || newHeuristicThread) {
        await createIdeThread(identity.key, wanted.provider, identity.project, identity.projectPath);
        state = await loadRuntimeState();
        thread = state.ideThreads[identity.key];
        threadSession = thread ? await getSession(thread.sessionId) : null;
      } else {
        thread = await refreshIdeThreadProject(identity.key, identity.projectPath) ?? thread;
        threadSession = await getSession(thread.sessionId);
      }
      if (!thread || !threadSession) throw new ApiError(500, 'session_create_failed', 'OneCode could not create the IDE API chat.');
      if (wanted.explicit && wanted.provider !== thread.provider && !threadSession.conversationId) {
        await createIdeThread(identity.key, wanted.provider, identity.project, identity.projectPath);
        state = await loadRuntimeState();
        thread = state.ideThreads[identity.key];
        threadSession = thread ? await getSession(thread.sessionId) : null;
        if (!thread || !threadSession) throw new ApiError(500, 'session_create_failed', 'OneCode could not create the provider-specific IDE chat.');
      }
      sessionId = thread.sessionId;
      session = threadSession;
      openingPending = thread.openingPending && !session.conversationId;
      ideWorkspaceBound = !!thread.projectId;
      preferredProvider = thread.provider;
    } else {
      if (!state.sessionId) state = await apiNewChat();
      sessionId = state.sessionId!;
      session = await getSession(sessionId);
      if (!session) {
        state = await apiNewChat(state.provider);
        sessionId = state.sessionId!;
        session = await getSession(sessionId);
        if (!session) throw new ApiError(500, 'session_create_failed', 'OneCode could not create the API chat.');
      }
      openingPending = state.openingPending && !session.conversationId;
    }

    let boundProvider = session.conversationId ? chatProviderForConversation(session.conversationId, state.provider) : null;
    if (boundProvider && wanted.explicit && wanted.provider !== boundProvider) {
      if (identity && !clientHasAnswer) {
        await createIdeThread(identity.key, wanted.provider, identity.project, identity.projectPath);
        state = await loadRuntimeState();
        const thread = state.ideThreads[identity.key];
        sessionId = thread?.sessionId ?? '';
        session = sessionId ? await getSession(sessionId) : null;
        if (!thread || !session) throw new ApiError(500, 'session_create_failed', 'OneCode could not create the provider-specific IDE chat.');
        openingPending = thread.openingPending && !session.conversationId;
        ideWorkspaceBound = !!thread.projectId;
        preferredProvider = thread.provider;
        boundProvider = null;
        logInfo('OneCode API opened a fresh ' + wanted.provider + ' IDE chat for explicit model ' + model + ' session=' + sessionId);
      } else if (!identity && !clientHasAnswer) {
        state = await apiNewChat(wanted.provider);
        sessionId = state.sessionId!;
        session = await getSession(sessionId);
        if (!session) throw new ApiError(500, 'session_create_failed', 'OneCode could not create the provider-specific API chat.');
        openingPending = state.openingPending;
        preferredProvider = wanted.provider;
        boundProvider = null;
      } else {
        throw new ApiError(409, 'provider_locked', 'This chat already belongs to ' + boundProvider + '. Use /new before switching providers.');
      }
    }
    const provider = boundProvider ?? preferredProvider;
    const text = requestPrompt(messages, ideWorkspaceBound, !!identity);
    let inputId: string = randomUUID();
    let row: InputEntry;
    if (openingPending && !session.conversationId) {
      inputId = sessionId;
      const existing = await existingOpening(sessionId);
      if (existing) {
        if (existing.text !== text || existing.chatProvider !== provider) {
          throw new ApiError(409, 'opening_pending', 'The first message for this API chat is already in progress. Wait for it or call /new.');
        }
        row = existing;
      } else {
        row = await sendDesktopInput({
          id: inputId, sessionId: null, provider, text, mode: 'auto', dueAt: Date.now(), model: null,
          reasoningEffort: null, authoredSource: 'text'
        });
      }
    } else {
      row = await sendDesktopInput({
        id: inputId, sessionId, provider, text, mode: 'auto', dueAt: Date.now(), model: null,
        reasoningEffort: null, authoredSource: 'text'
      });
    }
    const actualSessionId = row.sessionId ?? row.deliveredSessionId ?? sessionId;
    const final = await waitForFinal(inputId, actualSessionId, signal);
    if (ideKey) {
      await updateIdeThread(ideKey, provider, actualSessionId, false);
    } else {
      const current = await loadRuntimeState();
      if (current.sessionId === actualSessionId && current.openingPending) {
        await saveRuntimeState({ ...current, provider, openingPending: false });
      }
    }
    return {
      text: final.text, sessionId: actualSessionId, provider, conversationId: final.conversationId,
      inputId, model, completedAt: final.completedAt,
      ...(identity ? { ideProject: identity.project, workspaceBound: ideWorkspaceBound } : {})
    };
  } finally {
    completionActive = false;
  }
}

async function capabilitiesSnapshot(): Promise<unknown> {
  const config = getConfig();
  const enabled = effectiveCapabilities(config);
  const [library] = await Promise.all([listSkillLibrary()]);
  const pluginTools = pluginManager.tools();
  return {
    object: 'onecode.capabilities',
    app_version: APP_VERSION,
    live: true,
    note: 'This catalog is computed on every request. The OneCode agent itself discovers the same live tools through Core.',
    permissions: enabled,
    core_tools: [...SURFACES.core.tools],
    enabled_desktop_tools: desktopToolNames(enabled),
    multi_agent_enabled: config.multiAgent.enabled,
    plugins: pluginManager.snapshot().plugins.map(plugin => ({
      id: plugin.id, name: plugin.name, enabled: plugin.enabled, status: plugin.status,
      tools: plugin.tools.filter(tool => tool.enabled).map(tool => tool.name)
    })),
    plugin_tools: pluginTools.map(tool => ({ name: tool.name, description: tool.description ?? '', inputSchema: tool.inputSchema })),
    skills: library.skills.map(skill => ({
      id: skill.id, name: skill.name, description: skill.description, scope: skill.scope,
      source: skill.source, managed: skill.managed
    })),
    skill_errors: library.errors
  };
}

async function runtimeProjection(): Promise<unknown> {
  const state = await loadRuntimeState();
  const session = state.sessionId ? await getSession(state.sessionId) : null;
  const provider = session?.conversationId ? chatProviderForConversation(session.conversationId, state.provider) : state.provider;
  return {
    provider,
    default_provider: state.provider,
    session_id: state.sessionId,
    opening_pending: state.openingPending,
    conversation_bound: !!session?.conversationId
  };
}

function modelList(state: AgentApiRuntimeState): unknown {
  const created = Math.floor(Date.now() / 1000);
  const model = (id: string, provider: ChatProvider | 'selected') => ({
    id, object: 'model', created, owned_by: 'onecode',
    onecode: { provider, capabilities: '/v1/onecode/capabilities' }
  });
  return { object: 'list', data: [model('onecode', 'selected'), ...CHAT_PROVIDERS.map(provider => model(`onecode-${provider}`, provider))], onecode: { selected_provider: state.provider } };
}

function completionBody(result: AgentApiCompletionResult): unknown {
  return {
    id: 'chatcmpl-' + result.inputId.replace(/-/g, ''),
    object: 'chat.completion',
    created: Math.floor(result.completedAt / 1000),
    model: result.model,
    choices: [{ index: 0, message: { role: 'assistant', content: result.text }, finish_reason: 'stop' }],
    onecode: {
      session_id: result.sessionId, provider: result.provider, conversation_id: result.conversationId, input_id: result.inputId,
      ...(result.ideProject !== undefined ? { ide_project: result.ideProject, workspace_bound: result.workspaceBound === true } : {})
    }
  };
}

function responseBody(result: AgentApiCompletionResult): unknown {
  return {
    id: 'resp_' + result.inputId.replace(/-/g, ''),
    object: 'response',
    created_at: Math.floor(result.completedAt / 1000),
    status: 'completed',
    model: result.model,
    output: [{ id: 'msg_' + result.inputId.replace(/-/g, ''), type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: result.text, annotations: [] }] }],
    output_text: result.text,
    onecode: {
      session_id: result.sessionId, provider: result.provider, conversation_id: result.conversationId, input_id: result.inputId,
      ...(result.ideProject !== undefined ? { ide_project: result.ideProject, workspace_bound: result.workspaceBound === true } : {})
    }
  };
}

function streamChatCompletion(res: http.ServerResponse, result: AgentApiCompletionResult): void {
  const id = 'chatcmpl-' + result.inputId.replace(/-/g, '');
  const created = Math.floor(result.completedAt / 1000);
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-onecode-session': result.sessionId, 'x-onecode-provider': result.provider });
  res.write('data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created, model: result.model, choices: [{ index: 0, delta: { role: 'assistant', content: result.text }, finish_reason: null }] }) + '\n\n');
  res.write('data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created, model: result.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n');
  res.end('data: [DONE]\n\n');
}

function streamResponse(res: http.ServerResponse, result: AgentApiCompletionResult): void {
  const response = responseBody(result);
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-onecode-session': result.sessionId, 'x-onecode-provider': result.provider });
  res.write('event: response.completed\ndata: ' + JSON.stringify({ type: 'response.completed', response }) + '\n\n');
  res.end('data: [DONE]\n\n');
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse, instance: http.Server): Promise<void> {
  if (req.headers.origin !== undefined) throw new ApiError(403, 'origin_forbidden', 'Browser-origin requests are not allowed.');
  const port = (instance.address() as AddressInfo | null)?.port;
  const host = req.headers.host;
  if (!port || (host !== '127.0.0.1:' + port && host !== 'localhost:' + port)) {
    throw new ApiError(403, 'host_forbidden', 'Use this API through its loopback address.');
  }
  const token = activeToken;
  const authorization = req.headers.authorization ?? '';
  if (!token || !authorization.startsWith('Bearer ') || !safeEqual(authorization.slice(7), token)) {
    throw new ApiError(401, 'invalid_api_key', 'Invalid OneCode API key.');
  }
  const url = requestTarget(req);
  const route = url.pathname;
  const method = req.method ?? 'GET';

  if (method === 'GET' && (route === '/' || route === '/health' || route === '/v1/onecode/health')) {
    return reply(res, 200, { ok: true, object: 'onecode.health', app_version: APP_VERSION, base_url: agentApiBaseUrl(port), ...(await runtimeProjection() as Record<string, unknown>) });
  }
  if (method === 'GET' && route === '/v1/models') return reply(res, 200, modelList(await loadRuntimeState()));
  if (method === 'GET' && (route === '/capabilities' || route === '/v1/onecode/capabilities')) return reply(res, 200, await capabilitiesSnapshot());
  if (method === 'GET' && (route === '/provider' || route === '/v1/onecode/provider')) return reply(res, 200, await runtimeProjection());
  if (method === 'GET' && (route === '/session' || route === '/v1/onecode/session')) return reply(res, 200, await runtimeProjection());

  if (method === 'POST' && (route === '/provider' || route === '/v1/onecode/provider')) {
    const body = parseBody(providerBodySchema, await readJson(req));
    const state = await apiSelectProvider(body.provider);
    return reply(res, 200, { ok: true, ...(await runtimeProjection() as Record<string, unknown>), default_provider: state.provider, note: 'Existing chats keep their provider. Call /new to start with the new provider.' });
  }
  if (method === 'POST' && (route === '/new' || route === '/v1/onecode/new')) {
    const body = parseBody(newBodySchema, await readJson(req));
    const state = await apiNewChat(body.provider);
    return reply(res, 201, { ok: true, provider: state.provider, session_id: state.sessionId, opening_pending: true });
  }
  if (method === 'POST' && (route === '/session' || route === '/v1/onecode/session')) {
    const body = parseBody(sessionBodySchema, await readJson(req));
    await apiSelectSession(body.session_id);
    return reply(res, 200, { ok: true, ...(await runtimeProjection() as Record<string, unknown>) });
  }
  if (method === 'POST' && route === '/v1/chat/completions') {
    const body = parseBody(completionSchema, await readJson(req));
    const envelope = body as ApiEnvelope;
    logInfo('OneCode API chat request model=' + body.model + ' ' + requestShape(body.messages) + requestEnvelopeShape(envelope, body.messages));
    const gone = new AbortController();
    res.once('close', () => { if (!res.writableEnded) gone.abort(); });
    const result = await runSlashControl(body.model, body.messages) ??
      await runIdeHelper(body.model, body.messages) ??
      await runCompletion(body.model, body.messages, gone.signal, envelope);
    if (gone.signal.aborted || res.destroyed) return;
    if (body.stream) return streamChatCompletion(res, result);
    return reply(res, 200, completionBody(result), { 'x-onecode-session': result.sessionId, 'x-onecode-provider': result.provider });
  }
  if (method === 'POST' && route === '/v1/responses') {
    const body = parseBody(responsesSchema, await readJson(req));
    const messages = responsesMessages(body.input);
    const envelope = body as ApiEnvelope;
    logInfo('OneCode API responses request model=' + body.model + ' ' + requestShape(messages) + requestEnvelopeShape(envelope, messages));
    const gone = new AbortController();
    res.once('close', () => { if (!res.writableEnded) gone.abort(); });
    const result = await runSlashControl(body.model, messages) ??
      await runIdeHelper(body.model, messages) ??
      await runCompletion(body.model, messages, gone.signal, envelope);
    if (gone.signal.aborted || res.destroyed) return;
    if (body.stream) return streamResponse(res, result);
    return reply(res, 200, responseBody(result), { 'x-onecode-session': result.sessionId, 'x-onecode-provider': result.provider });
  }
  throw new ApiError(404, 'not_found', 'Unknown OneCode API route.');
}

async function startOnce(): Promise<void> {
  if (shutdownRequested || server || !getConfig().agentApi.enabled) return;
  const token = await ensureToken();
  await loadRuntimeState();
  const instance = http.createServer((req, res) => {
    handle(req, res, instance).catch(error => {
      if (error instanceof ClientGone) return;
      if (error instanceof ApiError) {
        if (!res.headersSent) replyError(res, error);
        else res.destroy();
        return;
      }
      logWarn('OneCode API request failed: ' + redact(error instanceof Error ? error.message : String(error)));
      if (!res.headersSent) replyError(res, new ApiError(500, 'internal_error', 'OneCode API request failed.'));
      else res.destroy();
    });
  });
  instance.headersTimeout = 15_000;
  instance.requestTimeout = 0;
  instance.keepAliveTimeout = 5_000;
  await new Promise<void>((resolve, reject) => {
    instance.once('error', reject);
    instance.listen(getConfig().agentApi.port, '127.0.0.1', () => {
      instance.off('error', reject);
      resolve();
    });
  });
  server = instance;
  activeToken = token;
  logInfo('OneCode API listening on 127.0.0.1:' + getConfig().agentApi.port);
}

async function stopOnce(): Promise<void> {
  const instance = server;
  server = null;
  activeToken = null;
  if (!instance) return;
  await new Promise<void>(resolve => {
    const force = setTimeout(() => instance.closeAllConnections(), DRAIN_MS);
    force.unref();
    instance.close(() => { clearTimeout(force); resolve(); });
    instance.closeIdleConnections();
  });
  logInfo('OneCode API stopped');
}

export function startAgentApi(): Promise<void> {
  return enqueueLifecycle(startOnce);
}

export function stopAgentApi(): Promise<void> {
  return enqueueLifecycle(stopOnce);
}

export function restartAgentApi(): Promise<void> {
  return enqueueLifecycle(async () => { await stopOnce(); await startOnce(); });
}

export function shutdownAgentApi(): Promise<void> {
  shutdownRequested = true;
  return enqueueLifecycle(stopOnce);
}

export function resetAgentApiForTests(): void {
  shutdownRequested = false;
  runtimeState = null;
  runtimeStateLoad = null;
  completionActive = false;
}
