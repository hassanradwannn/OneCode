/**
 * Local session capabilities for Gemini's stateless native MCP client.
 *
 * Gemini supplies neither the browser conversation id nor a request correlation id.
 * The paired companion may issue a capability for an already attached durable session;
 * the model carries it on outer tool calls. This proves local authorization only. It
 * never claims Google authenticated the declared conversation or the browser turn.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { mcpProvider } from '../mcp/provider-context.js';
import { INPUT_RECEIPT_WAIT_MS } from '../../shared/input.js';

const CONVERSATION = /^[a-f0-9]{16}$/;
const KEY = /^sk-gemini-session-[A-Za-z0-9_-]{43}$/;
const HASH = /^[a-f0-9]{64}$/;
const LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const RENEW_WITHIN_MS = 60 * 60 * 1000;
const MAX_BINDINGS = 20_000;
const MAX_LEDGER_BYTES = 8 * 1024 * 1024;
/** The actual task's browser receipt normally precedes its first native tool call. */
export const GEMINI_COMMAND_ACK_WAIT_MS = INPUT_RECEIPT_WAIT_MS;
export const GEMINI_INPUT_TURN_WAIT_MS = INPUT_RECEIPT_WAIT_MS;

export interface GeminiBindingCommand { id: string; owner: string; lease: string }
export interface GeminiBindingInput { id: string; owner: string; browser: string; offeredAt: number }
export interface GeminiBindingGoal { id: string; token: string; client: string; browser: string; tabId: number; documentId: string }
export interface GeminiBindingHandoff { provider: 'gemini'; accountPath: string; id: string; browser: string; tabId: number; documentId: string }
export interface GeminiInputTurn { inputId: string; messageId: string; historySeq: number; turnId: string }

interface BindingRow {
  id: string;
  conversationId: string;
  sessionId: string;
  keyHash: string;
  issuedAt: number;
  expiresAt: number;
  revoked: boolean;
  /** Dormant until the existing bridge command publishes its real Send receipt. */
  pendingCommand?: GeminiBindingCommand;
  /** Retained after activation: a previous input must never borrow a later receipt/turn. */
  input?: GeminiBindingInput;
  goal?: GeminiBindingGoal;
  handoff?: GeminiBindingHandoff;
  inputTurn?: GeminiInputTurn;
}
interface BindingLedger { version: 1; bindings: BindingRow[] }
export interface GeminiBindingCredential {
  conversation_id: string;
  session_key: string;
  session_id: string;
}
export interface GeminiBindingEvidence {
  /** Random local grant incarnation. No credential or credential digest is exposed. */
  bindingId: string;
  conversationId: string;
  sessionId: string;
  attribution: 'gemini_session_capability';
  /** Canonical local input/turn custody, not a Google request identifier. */
  inputTurn?: GeminiInputTurn;
  /** Save-only continuation custody; never ordinary workspace or input authority. */
  handoff?: GeminiBindingHandoff;
}

export class GeminiBindingError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'GeminiBindingError'; }
}
let ledgerPath = '';
let ready = false;
let rows = new Map<string, BindingRow>();
const issuedKeys = new Map<string, string>();
let tail: Promise<unknown> = Promise.resolve();
function fail(code: string): never { throw new GeminiBindingError(code); }
const hash = (key: string): Buffer => createHash('sha256').update(key).digest();

function serialized<T>(body: () => Promise<T>): Promise<T> {
  const work = tail.catch(() => undefined).then(body);
  tail = work.then(() => undefined, () => undefined);
  return work;
}
function validRow(value: unknown): value is BindingRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as BindingRow;
  return typeof row.id === 'string' && /^[a-f0-9-]{36}$/.test(row.id) &&
    typeof row.conversationId === 'string' && CONVERSATION.test(row.conversationId) &&
    typeof row.sessionId === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(row.sessionId) &&
    typeof row.keyHash === 'string' && HASH.test(row.keyHash) &&
    Number.isSafeInteger(row.issuedAt) && row.issuedAt > 0 &&
    Number.isSafeInteger(row.expiresAt) && row.expiresAt > row.issuedAt &&
    row.expiresAt - row.issuedAt <= LIFETIME_MS && typeof row.revoked === 'boolean' &&
    (row.pendingCommand === undefined || (typeof row.pendingCommand === 'object' && row.pendingCommand !== null &&
      typeof row.pendingCommand.id === 'string' && /^[a-f0-9]{16}$/.test(row.pendingCommand.id) &&
      typeof row.pendingCommand.owner === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(row.pendingCommand.owner) &&
      typeof row.pendingCommand.lease === 'string' && /^[a-f0-9]{16}$/.test(row.pendingCommand.lease))) &&
    (row.input === undefined || (typeof row.input === 'object' && row.input !== null && !row.pendingCommand && !row.goal &&
      !row.handoff && typeof row.input.id === 'string' && /^[a-f0-9-]{36}$/i.test(row.input.id) &&
      typeof row.input.owner === 'string' && row.input.owner.length > 0 && row.input.owner.length <= 160 &&
      typeof row.input.browser === 'string' && /^[a-z0-9]{16,64}$/.test(row.input.browser) &&
      Number.isFinite(row.input.offeredAt) && row.input.offeredAt > 0)) &&
    (row.goal === undefined || (typeof row.goal === 'object' && row.goal !== null && !row.input && !row.pendingCommand &&
      !row.handoff && typeof row.goal.id === 'string' && /^[a-f0-9-]{36}$/i.test(row.goal.id) && typeof row.goal.token === 'string' && /^goal-[a-z0-9-]{1,80}$/.test(row.goal.token) &&
      typeof row.goal.client === 'string' && row.goal.client === String(row.goal.tabId) && Number.isSafeInteger(row.goal.tabId) && row.goal.tabId >= 0 &&
      typeof row.goal.browser === 'string' && /^[a-z0-9]{16,64}$/.test(row.goal.browser) &&
      typeof row.goal.documentId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(row.goal.documentId))) &&
    (row.handoff === undefined || (typeof row.handoff === 'object' && row.handoff !== null && !row.input && !row.goal && !row.pendingCommand &&
      row.handoff.provider === 'gemini' && (row.handoff.accountPath === '' || /^\/u\/[0-9]+$/.test(row.handoff.accountPath)) &&
      /^[A-Za-z0-9_-]{43}$/.test(row.handoff.id) && /^[a-z0-9]{16,64}$/.test(row.handoff.browser) &&
      Number.isSafeInteger(row.handoff.tabId) && row.handoff.tabId >= 0 && /^[A-Za-z0-9_-]{1,64}$/.test(row.handoff.documentId))) &&
    (row.inputTurn === undefined || ((row.input !== undefined || row.goal !== undefined) && row.inputTurn?.inputId === (row.input ?? row.goal)!.id &&
      typeof row.inputTurn.messageId === 'string' && row.inputTurn.messageId.length > 0 && row.inputTurn.messageId.length <= 256 &&
      Number.isSafeInteger(row.inputTurn.historySeq) && row.inputTurn.historySeq > 0 &&
      typeof row.inputTurn.turnId === 'string' && row.inputTurn.turnId.length > 0 && row.inputTurn.turnId.length <= 256));
}

/** Await after initSessionStore. Corruption fails closed; it never becomes a fresh grant. */
export async function initGeminiBindings(userDataDir: string): Promise<void> {
  await serialized(async () => {
    ready = false;
    issuedKeys.clear();
    rows = new Map();
    ledgerPath = path.join(userDataDir, 'state', 'gemini-bindings.json');
    let raw: string;
    try {
      const stat = await fs.stat(ledgerPath);
      if (!stat.isFile() || stat.size > MAX_LEDGER_BYTES) fail('GEMINI_BINDING_STATE_INVALID');
      raw = await fs.readFile(ledgerPath, 'utf8');
      if (Buffer.byteLength(raw) > MAX_LEDGER_BYTES) fail('GEMINI_BINDING_STATE_INVALID');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { ready = true; return; }
      fail('GEMINI_BINDING_STATE_UNAVAILABLE');
    }
    let data: BindingLedger;
    try { data = JSON.parse(raw!) as BindingLedger; } catch { fail('GEMINI_BINDING_STATE_INVALID'); }
    if (!data! || data!.version !== 1 || !Array.isArray(data!.bindings) || data!.bindings.length > MAX_BINDINGS ||
        !data!.bindings.every(validRow)) fail('GEMINI_BINDING_STATE_INVALID');
    const restored = new Map(data!.bindings.map(row => [row.conversationId, row]));
    if (restored.size !== data!.bindings.length || new Set(data!.bindings.map(row => row.id)).size !== restored.size) {
      fail('GEMINI_BINDING_STATE_INVALID');
    }
    rows = restored;
    ready = true;
  });
}

/** True also while a failed initialization is quarantined: callers must not fall back. */
export function geminiBindingsEnabled(): boolean { return ledgerPath !== '' && mcpProvider() === 'gemini'; }

async function persist(next: Map<string, BindingRow>): Promise<void> {
  if (!ready || !ledgerPath) fail('GEMINI_BINDING_STATE_UNAVAILABLE');
  const body = JSON.stringify({ version: 1, bindings: [...next.values()] } satisfies BindingLedger);
  if (Buffer.byteLength(body) > MAX_LEDGER_BYTES) fail('GEMINI_BINDING_LIMIT');
  const temp = `${ledgerPath}.${randomUUID()}.tmp`;
  try {
    await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
    const handle = await fs.open(temp, 'wx', 0o600);
    try { await handle.writeFile(body, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temp, ledgerPath);
  } catch {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    fail('GEMINI_BINDING_SAVE_FAILED');
  }
  // Authority changes only after durable publication succeeded.
  rows = next;
}

async function sessionFor(conversationId: string, requested?: string): Promise<string> {
  if (!CONVERSATION.test(conversationId)) fail('INVALID_GEMINI_CONVERSATION_ID');
  // Defer the existing owner graph until startup/call time. Store/recorder/bridge/tools
  // already share module boundaries; publishing schemas must not initialize that graph.
  const { conversationAttachment, findSessionByConversation } = await import('../session/store.js');
  // Never manufacture a session from a model-supplied id. The store remains the owner.
  const session = await findSessionByConversation(conversationId, { requireUnique: true });
  if (!session || (requested && requested !== session.id) ||
      await conversationAttachment(conversationId, session.id) !== 'current') {
    fail('GEMINI_SESSION_NOT_ATTACHED');
  }
  return session.id;
}

async function issue(conversationId: string, requested: string | undefined, rotate: boolean,
  pendingCommand?: GeminiBindingCommand, input?: GeminiBindingInput, goal?: GeminiBindingGoal, handoff?: GeminiBindingHandoff): Promise<GeminiBindingCredential> {
  return serialized(async () => {
    if (!ready) fail('GEMINI_BINDING_STATE_UNAVAILABLE');
    let sessionId: string;
    if (pendingCommand) {
      if (!CONVERSATION.test(conversationId) || !requested) fail('GEMINI_COMMAND_NOT_OWNED');
      const { geminiCommandBindingStatus } = await import('../bridge.js');
      if (await geminiCommandBindingStatus(pendingCommand, conversationId, requested) === 'invalid') fail('GEMINI_COMMAND_NOT_OWNED');
      sessionId = requested;
    } else sessionId = await sessionFor(conversationId, requested);
    const previous = rows.get(conversationId);
    const cached = issuedKeys.get(conversationId);
    // Approval policy refreshes carry no task custody. Reuse the exact grant;
    // never replace a dormant command key or downgrade its ACK requirement.
    if (!rotate && !input && !goal && !pendingCommand && !handoff && (previous?.pendingCommand || previous?.input || previous?.goal || previous?.handoff)) {
      if (previous.pendingCommand && await (await import('../bridge.js')).geminiCommandBindingStatus(previous.pendingCommand, conversationId, sessionId) === 'invalid')
        fail('GEMINI_COMMAND_NOT_OWNED');
      if (previous.handoff && await (await import('../session/continuation.js')).geminiHandoffBindingStatus(previous.handoff, conversationId, sessionId) === 'invalid')
        fail('GEMINI_HANDOFF_NOT_OWNED');
      if (previous.revoked || previous.sessionId !== sessionId || !cached || previous.expiresAt <= Date.now()) fail(previous.pendingCommand ? 'GEMINI_COMMAND_BINDING_REQUIRED' : previous.handoff ? 'GEMINI_HANDOFF_BINDING_REQUIRED' : previous.goal ? 'GEMINI_GOAL_BINDING_REQUIRED' : 'GEMINI_INPUT_BINDING_REQUIRED');
      return { conversation_id: conversationId, session_key: cached, session_id: sessionId };
    }
    if (input) {
      const { geminiInputBindingStatus } = await import('../session/input.js');
      if ((await geminiInputBindingStatus(input, conversationId, sessionId)).state === 'invalid') fail('GEMINI_INPUT_NOT_OWNED');
    }
    if (goal && (await (await import('../goal.js')).geminiGoalBindingStatus(goal, conversationId, sessionId)).state === 'invalid') fail('GEMINI_GOAL_NOT_OWNED');
    if (handoff && await (await import('../session/continuation.js')).geminiHandoffBindingStatus(handoff, conversationId, sessionId) === 'invalid') fail('GEMINI_HANDOFF_NOT_OWNED');
    if (!rotate && previous && !previous.revoked && previous.sessionId === sessionId && cached &&
        previous.pendingCommand?.id === pendingCommand?.id && previous.pendingCommand?.owner === pendingCommand?.owner &&
        previous.pendingCommand?.lease === pendingCommand?.lease &&
        previous.input?.id === input?.id && previous.input?.owner === input?.owner &&
        previous.input?.browser === input?.browser && previous.input?.offeredAt === input?.offeredAt &&
        previous.goal?.id === goal?.id && previous.goal?.token === goal?.token && previous.goal?.client === goal?.client &&
        previous.goal?.browser === goal?.browser && previous.goal?.tabId === goal?.tabId && previous.goal?.documentId === goal?.documentId &&
        JSON.stringify(previous.handoff) === JSON.stringify(handoff) &&
        previous.expiresAt > Date.now() + RENEW_WITHIN_MS) {
      return { conversation_id: conversationId, session_key: cached, session_id: sessionId };
    }
    if (!previous && rows.size >= MAX_BINDINGS) fail('GEMINI_BINDING_LIMIT');
    const key = `sk-gemini-session-${randomBytes(32).toString('base64url')}`;
    const now = Date.now();
    const row: BindingRow = { id: randomUUID(), conversationId, sessionId, keyHash: hash(key).toString('hex'),
      issuedAt: now, expiresAt: now + LIFETIME_MS, revoked: false, ...(pendingCommand ? { pendingCommand } : {}), ...(input ? { input } : {}), ...(goal ? { goal } : {}), ...(handoff ? { handoff } : {}) };
    const next = new Map(rows); next.set(conversationId, row);
    await persist(next);
    issuedKeys.set(conversationId, key);
    return { conversation_id: conversationId, session_key: key, session_id: sessionId };
  });
}

/** Paired bridge/UI only. Reuses one grant during this process; fresh issue after restart rotates. */
export function ensureGeminiBinding(conversationId: string, sessionId?: string): Promise<GeminiBindingCredential> {
  return issue(conversationId, sessionId, false);
}
export function rotateGeminiBinding(conversationId: string, sessionId?: string): Promise<GeminiBindingCredential> {
  return issue(conversationId, sessionId, true);
}
/** Paired bridge only, after exact command/document custody. Warmup grants no execution. */
export function prepareGeminiCommandBinding(conversationId: string, sessionId: string,
  command: GeminiBindingCommand): Promise<GeminiBindingCredential> {
  return issue(conversationId, sessionId, false, command);
}
/** Paired bridge only, after the existing outbox proves this exact browser/document claim. */
export function prepareGeminiInputBinding(conversationId: string, sessionId: string,
  input: GeminiBindingInput): Promise<GeminiBindingCredential> {
  return issue(conversationId, sessionId, false, undefined, input);
}
export function prepareGeminiGoalBinding(conversationId: string, sessionId: string,
  goal: GeminiBindingGoal): Promise<GeminiBindingCredential> {
  return issue(conversationId, sessionId, false, undefined, undefined, goal);
}
export function prepareGeminiHandoffBinding(conversationId: string, sessionId: string, handoff: GeminiBindingHandoff): Promise<GeminiBindingCredential> {
  return issue(conversationId, sessionId, false, undefined, undefined, undefined, handoff);
}
export async function revokeGeminiBinding(conversationId: string): Promise<void> {
  await serialized(async () => {
    if (!ready) fail('GEMINI_BINDING_STATE_UNAVAILABLE');
    const row = rows.get(conversationId);
    if (!row) return;
    const next = new Map(rows); next.set(conversationId, { ...row, revoked: true });
    await persist(next);
    issuedKeys.delete(conversationId);
  });
}

function currentRow(evidence: GeminiBindingEvidence): BindingRow | null {
  const row = ready ? rows.get(evidence.conversationId) : null;
  return row && row.id === evidence.bindingId && row.sessionId === evidence.sessionId &&
    !row.pendingCommand && (!(row.input || row.goal) || !!row.inputTurn) && sameInputTurn(row.inputTurn, evidence.inputTurn) &&
    JSON.stringify(row.handoff) === JSON.stringify(evidence.handoff) &&
    !row.revoked && row.expiresAt > Date.now() ? row : null;
}
const sameInputTurn = (left?: GeminiInputTurn, right?: GeminiInputTurn) =>
  left?.inputId === right?.inputId && left?.messageId === right?.messageId && left?.historySeq === right?.historySeq && left?.turnId === right?.turnId;

async function activateInputBinding(row: BindingRow): Promise<void> {
  if (!(row.input || row.goal) || row.inputTurn) return;
  const statusFor = async () => row.input
    ? (await import('../session/input.js')).geminiInputBindingStatus(row.input, row.conversationId, row.sessionId)
    : (await import('../goal.js')).geminiGoalBindingStatus(row.goal!, row.conversationId, row.sessionId);
  const deadline = performance.now() + GEMINI_INPUT_TURN_WAIT_MS;
  for (;;) {
    const current = rows.get(row.conversationId);
    if (current?.id !== row.id || current.revoked || current.expiresAt <= Date.now()) fail('GEMINI_SESSION_AUTHORIZATION_EXPIRED');
    if (current.inputTurn) return;
    const status = await statusFor();
    if (status.state === 'invalid') fail(row.goal ? 'GEMINI_GOAL_NOT_OWNED' : 'GEMINI_INPUT_NOT_OWNED');
    if (status.state === 'ready') {
      await serialized(async () => {
        const live = rows.get(row.conversationId);
        if (live?.id !== row.id || live.revoked || live.expiresAt <= Date.now()) fail('GEMINI_SESSION_AUTHORIZATION_EXPIRED');
        const exact = await statusFor();
        if (exact.state !== 'ready' || !sameInputTurn(exact.turn, status.turn)) fail(row.goal ? 'GEMINI_GOAL_NOT_OWNED' : 'GEMINI_INPUT_NOT_OWNED');
        await sessionFor(live.conversationId, live.sessionId);
        const next = new Map(rows); next.set(live.conversationId, { ...live, inputTurn: { ...exact.turn } });
        await persist(next);
      });
      return;
    }
    if (performance.now() >= deadline) fail('GEMINI_INPUT_TURN_PENDING');
    await new Promise<void>(resolve => { const timer = setTimeout(resolve, 50); timer.unref?.(); });
  }
}

async function activateCommandBinding(row: BindingRow): Promise<void> {
  if (!row.pendingCommand) return;
  const { geminiCommandBindingStatus } = await import('../bridge.js');
  const deadline = performance.now() + GEMINI_COMMAND_ACK_WAIT_MS;
  for (;;) {
    const current = rows.get(row.conversationId);
    if (current?.id !== row.id || current.revoked || current.expiresAt <= Date.now()) fail('GEMINI_SESSION_AUTHORIZATION_EXPIRED');
    if (!current.pendingCommand) return;
    const status = await geminiCommandBindingStatus(current.pendingCommand, row.conversationId, row.sessionId);
    if (status === 'invalid') fail('GEMINI_COMMAND_NOT_OWNED');
    if (status === 'committed') {
      await serialized(async () => {
        const live = rows.get(row.conversationId);
        if (live?.id !== row.id || live.revoked || live.expiresAt <= Date.now()) fail('GEMINI_SESSION_AUTHORIZATION_EXPIRED');
        if (!live.pendingCommand) return;
        if (await geminiCommandBindingStatus(live.pendingCommand, live.conversationId, live.sessionId) !== 'committed') fail('GEMINI_COMMAND_NOT_OWNED');
        await sessionFor(live.conversationId, live.sessionId);
        const { pendingCommand: _command, ...active } = live;
        const next = new Map(rows); next.set(live.conversationId, active);
        await persist(next);
      });
      return;
    }
    if (performance.now() >= deadline) fail('GEMINI_COMMAND_ACK_PENDING');
    await new Promise<void>(resolve => { const timer = setTimeout(resolve, 50); timer.unref?.(); });
  }
}
/** Synchronous final fence, after any awaited policy/session check and before entering a handler. */
export function geminiBindingIsCurrent(evidence: GeminiBindingEvidence): boolean { return currentRow(evidence) !== null; }

/** Receipt settlement only: an ended admitted turn cannot authorize another handler. */
export async function validateGeminiBindingReceiptEvidence(evidence: GeminiBindingEvidence): Promise<void> {
  if (!currentRow(evidence)) fail('GEMINI_SESSION_AUTHORIZATION_EXPIRED');
  await sessionFor(evidence.conversationId, evidence.sessionId);
  if (!currentRow(evidence)) fail('GEMINI_SESSION_AUTHORIZATION_EXPIRED');
}

export async function validateGeminiBindingEvidence(evidence: GeminiBindingEvidence): Promise<void> {
  if (!currentRow(evidence)) fail('GEMINI_SESSION_AUTHORIZATION_EXPIRED');
  const { getSession, findSessionByConversation, conversationAttachment } = await import('../session/store.js');
  const session = await getSession(evidence.sessionId);
  if (!session || session.conversationId !== evidence.conversationId ||
      (await findSessionByConversation(evidence.conversationId, { requireUnique: true }))?.id !== evidence.sessionId ||
      await conversationAttachment(evidence.conversationId, evidence.sessionId) !== 'current') {
    fail('GEMINI_SESSION_NOT_ATTACHED');
  }
  const scoped = currentRow(evidence);
  if (scoped?.input) {
    const { geminiInputBindingStatus } = await import('../session/input.js');
    const status = await geminiInputBindingStatus(scoped.input, scoped.conversationId, scoped.sessionId);
    if (status.state !== 'ready' || !sameInputTurn(status.turn, evidence.inputTurn)) fail('GEMINI_INPUT_NOT_OWNED');
  }
  if (scoped?.goal) {
    const status = await (await import('../goal.js')).geminiGoalBindingStatus(scoped.goal, scoped.conversationId, scoped.sessionId);
    if (status.state !== 'ready' || !sameInputTurn(status.turn, evidence.inputTurn)) fail('GEMINI_GOAL_NOT_OWNED');
  }
  if (scoped?.handoff && await (await import('../session/continuation.js')).geminiHandoffBindingStatus(scoped.handoff, scoped.conversationId, scoped.sessionId) !== 'ready')
    fail('GEMINI_HANDOFF_NOT_OWNED');
  if (!currentRow(evidence)) fail('GEMINI_SESSION_AUTHORIZATION_EXPIRED');
}

/** Outer HTTP calls only; neither RPC id nor transport headers are conversation proof. */
export async function authenticateGeminiBinding(args: unknown): Promise<GeminiBindingEvidence> {
  if (!ready) fail('GEMINI_BINDING_STATE_UNAVAILABLE');
  if (!args || typeof args !== 'object' || Array.isArray(args)) fail('GEMINI_SESSION_BINDING_REQUIRED');
  const input = args as Record<string, unknown>;
  if (typeof input.conversation_id !== 'string' || !CONVERSATION.test(input.conversation_id) ||
      typeof input.session_key !== 'string' || !KEY.test(input.session_key)) fail('GEMINI_SESSION_BINDING_REQUIRED');
  const conversationId = input.conversation_id as string;
  const key = input.session_key as string;
  const row = rows.get(conversationId);
  // Always compare two fixed-length digests, including the missing-row case.
  const matches = timingSafeEqual(hash(key), row ? Buffer.from(row.keyHash, 'hex') : Buffer.alloc(32));
  if (!row || !matches) fail('GEMINI_SESSION_NOT_AUTHORIZED');
  await activateCommandBinding(row);
  await activateInputBinding(row);
  if (row.handoff) {
    const deadline = performance.now() + GEMINI_INPUT_TURN_WAIT_MS;
    for (;;) {
      const current = rows.get(conversationId);
      if (current?.id !== row.id || current.revoked || current.expiresAt <= Date.now()) fail('GEMINI_SESSION_AUTHORIZATION_EXPIRED');
      const status = await (await import('../session/continuation.js')).geminiHandoffBindingStatus(row.handoff, row.conversationId, row.sessionId);
      if (status === 'ready') break;
      if (status === 'invalid') fail('GEMINI_HANDOFF_NOT_OWNED');
      if (performance.now() >= deadline) fail('GEMINI_HANDOFF_ACK_PENDING');
      await new Promise<void>(resolve => { const timer = setTimeout(resolve, 50); timer.unref?.(); });
    }
  }
  const active = rows.get(conversationId);
  const evidence: GeminiBindingEvidence = { bindingId: row.id, conversationId, sessionId: row.sessionId,
    attribution: 'gemini_session_capability', ...(active?.inputTurn ? { inputTurn: { ...active.inputTurn } } : {}), ...(active?.handoff ? { handoff: { ...active.handoff } } : {}) };
  await validateGeminiBindingEvidence(evidence);
  return evidence;
}

/** Routing is consumed before the existing tools' strict validation and exact recording. */
export function stripGeminiRoutingArgs(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return {};
  const { conversation_id: _conversation, session_key: _key, ...toolArgs } = args as Record<string, unknown>;
  return toolArgs;
}

/** Test lifetime only. Production revocation always uses its durable owner above. */
export async function resetGeminiBindingsForTests(): Promise<void> {
  await tail;
  ready = false; ledgerPath = ''; rows = new Map(); issuedKeys.clear();
}
