/**
 * Native provider connectors may omit trustworthy native request correlation. An app-authored
 * input/worker command can instead carry an opaque local capability through exec.
 * The durable ledger owns no chat identity: every admission rechecks the original
 * outbox or command receipt, current attachment and turn.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { GeminiBindingEvidence, GeminiBindingInput, GeminiInputTurn, GeminiBindingGoal } from '../gemini/bindings.js';
import { GeminiBindingError, geminiBindingIsCurrent, validateGeminiBindingEvidence, validateGeminiBindingReceiptEvidence } from '../gemini/bindings.js';
import { mcpProvider } from '../mcp/provider-context.js';
import { configuredConnectorName } from '../mcp/surfaces.js';
import { getConfig } from '../config.js';
import { INPUT_RECEIPT_WAIT_MS } from '../../shared/input.js';
import { readDurable, writeDurableNow } from '../durable.js';
import { authorityInstallationId } from '../secrets.js';
import { isChatProviderConversationId, type ChatProvider } from '../../shared/chat-provider.js';
import { hasInFlightLocalBinding } from '../mcp/call-context.js';

export type LocalCapabilityProvider = 'chatgpt' | 'claude';
export interface BrowserBindingEvidence {
  bindingId: string;
  conversationId: string;
  sessionId: string;
  attribution: 'chatgpt_session_capability' | 'claude_session_capability';
  inputTurn?: GeminiInputTurn;
  handoff?: never;
}
export type ChatgptBindingEvidence = BrowserBindingEvidence & { attribution: 'chatgpt_session_capability' };
export type LocalBindingEvidence = GeminiBindingEvidence | BrowserBindingEvidence;
export type LocalBindingStatus = { state: 'pending' | 'invalid' | 'blocked' | 'unresolved' } |
  { state: 'ready'; conversationId: string; sessionId: string; turn?: GeminiInputTurn };
export type LocalBindingProof = { kind: 'input'; input: GeminiBindingInput } |
  { kind: 'command'; id: string; owner: string; lease: string } |
  { kind: 'goal'; conversationId: string; sessionId: string; goal: GeminiBindingGoal };
export type ChatgptBindingProof = LocalBindingProof;
type Grant = { id: string; digest: string; proof: LocalBindingProof; issuedAt: number; activated?: BrowserBindingEvidence };
type Ledger = { version: 2; installationId: string; grants: Grant[] };
const INIT_RETRY_INTERVAL_MS = 1_000;
const digest = (key: string) => createHash('sha256').update(key).digest('hex');
const PREFIX = /^\/\/ onecode-session: (sk-onecode-session-[A-Za-z0-9_-]{43})\r?\n/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_GRANTS = 20_000;
type AdmissionReason = 'proof-unavailable' | 'provider-mismatch' | 'credential-shape' | 'credential-unknown' |
  'proof-invalid' | 'blocked' | 'receipt-pending' | 'activation-changed';
/** Fixed diagnostic vocabulary only. Never retain a credential, digest or task. */
export class LocalBindingError extends GeminiBindingError {
  constructor(readonly provider: LocalCapabilityProvider, readonly admissionReason: AdmissionReason) {
    super(provider === 'chatgpt' ? 'CHATGPT_SESSION_NOT_AUTHORIZED' : 'CLAUDE_SESSION_NOT_AUTHORIZED');
  }
}
export class ChatgptBindingError extends LocalBindingError {
  constructor(reason: AdmissionReason) { super('chatgpt', reason); }
}
export function usesLocalTaskCapability(provider: ChatProvider): provider is LocalCapabilityProvider {
  return provider === 'chatgpt' || provider === 'claude';
}

/** Independent owners share one admission algorithm. Existing ChatGPT ledger bytes stay compatible. */
function createLocalBindingOwner(provider: LocalCapabilityProvider) {
  const grants = new Map<string, Grant>();
  let ready = false;
  let installationId = '';
  let tail: Promise<unknown> = Promise.resolve();
  let initInFlight: Promise<void> | null = null;
  let lastInitAttemptAt = 0;
  let retirementCursor = 0;
  const attribution = provider === 'chatgpt' ? 'chatgpt_session_capability' : 'claude_session_capability';
  const ledgerName = `${provider}-bindings`;
  const fail = (reason: AdmissionReason = 'proof-unavailable'): never => {
    throw provider === 'chatgpt' ? new ChatgptBindingError(reason) : new LocalBindingError(provider, reason);
  };

  function validGrant(value: unknown): value is Grant {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const grant = value as Grant;
    if (typeof grant.id !== 'string' || !/^[a-f0-9-]{36}$/.test(grant.id) ||
        typeof grant.digest !== 'string' || !HASH.test(grant.digest) ||
        !Number.isSafeInteger(grant.issuedAt) || grant.issuedAt <= 0 ||
        !grant.proof || typeof grant.proof !== 'object') return false;
    if (grant.proof.kind === 'input') {
      const input = grant.proof.input;
      if (!input || typeof input.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(input.id) ||
          typeof input.owner !== 'string' || input.owner.length === 0 || input.owner.length > 160 ||
          typeof input.browser !== 'string' || !/^[a-z0-9]{16,64}$/.test(input.browser) ||
          !Number.isFinite(input.offeredAt) || input.offeredAt <= 0) return false;
    } else if (grant.proof.kind === 'command') {
      if (typeof grant.proof.id !== 'string' || !/^(?:[a-f0-9]{16}|[a-f0-9-]{36})$/i.test(grant.proof.id) ||
          typeof grant.proof.owner !== 'string' || grant.proof.owner.length === 0 || grant.proof.owner.length > 160 ||
          typeof grant.proof.lease !== 'string' || grant.proof.lease.length === 0 || grant.proof.lease.length > 160) return false;
    } else if (grant.proof.kind === 'goal') {
      const { goal, conversationId, sessionId } = grant.proof;
      if (provider !== 'claude' || !isChatProviderConversationId(conversationId, provider) ||
          typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(sessionId) || !goal ||
          typeof goal.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(goal.id) ||
          typeof goal.token !== 'string' || !/^goal-[a-z0-9-]{1,80}$/.test(goal.token) ||
          !Number.isSafeInteger(goal.tabId) || goal.tabId < 0 || goal.client !== String(goal.tabId) ||
          typeof goal.browser !== 'string' || !/^[a-z0-9]{16,64}$/.test(goal.browser) ||
          typeof goal.documentId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(goal.documentId)) return false;
    } else return false;
    if (grant.activated !== undefined) {
      const evidence = grant.activated;
      if (!evidence || evidence.attribution !== attribution || evidence.bindingId !== grant.id ||
          typeof evidence.conversationId !== 'string' ||
          !isChatProviderConversationId(evidence.conversationId, provider) ||
          typeof evidence.sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(evidence.sessionId)) return false;
      if (evidence.inputTurn && (typeof evidence.inputTurn.inputId !== 'string' ||
          evidence.inputTurn.inputId !== (grant.proof.kind === 'input' ? grant.proof.input.id : grant.proof.kind === 'goal' ? grant.proof.goal.id : grant.proof.id) ||
          typeof evidence.inputTurn.messageId !== 'string' || !evidence.inputTurn.messageId || evidence.inputTurn.messageId.length > 256 ||
          !Number.isSafeInteger(evidence.inputTurn.historySeq) || evidence.inputTurn.historySeq <= 0 ||
          typeof evidence.inputTurn.turnId !== 'string' || !evidence.inputTurn.turnId || evidence.inputTurn.turnId.length > 256)) return false;
    }
    return true;
  }

  function serialized<T>(body: () => Promise<T>): Promise<T> {
    const work = tail.catch(() => undefined).then(body);
    tail = work.then(() => undefined, () => undefined);
    return work;
  }

  /** Restore before MCP/bridge admission. Failed reads remain fail closed and are retried at a bounded rate. */
  function init(): Promise<void> {
    if (ready) return Promise.resolve();
    if (initInFlight) return initInFlight;
    if (Date.now() - lastInitAttemptAt < INIT_RETRY_INTERVAL_MS) return Promise.reject(provider === 'chatgpt' ? new ChatgptBindingError('proof-unavailable') : new LocalBindingError(provider, 'proof-unavailable'));
    lastInitAttemptAt = Date.now();
    const initializing = serialized(async () => {
      ready = false;
      grants.clear();
      installationId = await authorityInstallationId();
      let ledger: unknown;
      try { ledger = await readDurable<unknown>(ledgerName, { strict: true }); }
      catch { fail(); }
      if (ledger === null) { ready = true; return; }
      if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger) ||
          (ledger as Ledger).version !== 2 || (ledger as Ledger).installationId !== installationId || !Array.isArray((ledger as Ledger).grants) ||
          (ledger as Ledger).grants.length > MAX_GRANTS || !(ledger as Ledger).grants.every(validGrant)) fail();
      const rows = (ledger as Ledger).grants;
      if (new Set(rows.map(row => row.digest)).size !== rows.length || new Set(rows.map(row => row.id)).size !== rows.length) fail();
      for (const row of rows) grants.set(row.digest, row);
      ready = true;
    });
    initInFlight = initializing;
    void initializing.finally(() => { if (initInFlight === initializing) initInFlight = null; }).catch(() => undefined);
    return initializing;
  }

  async function commit(next: Map<string, Grant>): Promise<void> {
    if (!ready) fail();
    await writeDurableNow(ledgerName, { version: 2, installationId, grants: [...next.values()] } satisfies Ledger);
    grants.clear();
    for (const [key, value] of next) grants.set(key, value);
  }

  async function retireInvalid(grant: Grant): Promise<void> {
    await serialized(async () => {
      const live = grants.get(grant.digest);
      if (!live || live.id !== grant.id) return;
      if (live.activated && hasInFlightLocalBinding(live.id, live.activated.conversationId, live.activated.sessionId)) return;
      // The observation that refused this call may have raced with a reversible
      // state transition. Recheck under the ledger owner before deleting anything.
      if ((await status(live)).state !== 'invalid') return;
      if (live.activated && hasInFlightLocalBinding(live.id, live.activated.conversationId, live.activated.sessionId)) return;
      const next = new Map(grants); next.delete(grant.digest); await commit(next);
    });
  }

  /** Preparation may reuse frozen text only while its exact unsent claim still
   * owns the embedded durable credential. This never authorizes execution. */
  function hasCurrent(text: string, proof: LocalBindingProof): boolean {
    if (!ready) return false;
    const keys = [...text.matchAll(/^\/\/ onecode-session: (sk-onecode-session-[A-Za-z0-9_-]{43})\r?$/gm)];
    return keys.some(match => {
      const grant = grants.get(digest(match[1]!));
      return !!grant && JSON.stringify(grant.proof) === JSON.stringify(proof);
    });
  }

  /** Called only inside the paired outbox/command claim owner, never by an MCP tool. */
  async function instructions(proof: LocalBindingProof): Promise<string> {
    if (!ready) await init();
    const key = `sk-onecode-session-${randomBytes(32).toString('base64url')}`;
    const grant = { id: randomUUID(), digest: digest(key), proof: structuredClone(proof), issuedAt: Date.now() };
    if (!validGrant(grant)) fail('proof-invalid');
    await serialized(async () => {
      const next = new Map(grants);
      // Retire proved lifecycle changes incrementally. Neither age nor cache pressure
      // can remove a valid or pending task, and a failed proof read preserves it.
      const candidates = [...grants.values()];
      const count = Math.min(32, candidates.length);
      for (let index = 0; index < count; index++) {
        const candidate = candidates[(retirementCursor + index) % candidates.length]!;
        try {
          if ((await status(candidate)).state === 'invalid' && !(candidate.activated &&
              hasInFlightLocalBinding(candidate.id, candidate.activated.conversationId, candidate.activated.sessionId))) next.delete(candidate.digest);
        }
        catch { /* Storage/owner readiness is uncertain, never revocation. */ }
      }
      retirementCursor = candidates.length ? (retirementCursor + count) % candidates.length : 0;
      if (next.size >= MAX_GRANTS) throw new Error('Local session capability storage is full; existing valid task access is preserved');
      next.set(grant.digest, grant); await commit(next);
    });
    if (provider === 'chatgpt' && getConfig().mcp.useChatgptWebSkill === true) return `Use the installed onecode-${provider} skill with ${configuredConnectorName('core')}. For this exact app-authored task, use that Core connector's exec tool for ordinary OneCode local tools, including plugins, plans and agents; nested tools inside exec inherit this local session authorization. Fresh authorization for this exact task: start every outer exec code with this first line:
// onecode-session: ${key}
Then JavaScript. Do not make a direct OneCode tool call unless its current schema accepts onecode_session_key; ${provider === 'chatgpt' ? 'without the fresh key it is Unattributed.' : 'without the fresh key local task authorization is unavailable.'} Direct native calls that require it, including session_finish, use onecode_session_key="${key}". This replaces older credentials. Never print or copy the key. If authorization is rejected, stop and let OneCode reconcile this exact task and receipt; do not infer a new task or replay an uncertain mutation.`;
    return `For this exact app-authored task, use ${configuredConnectorName('core')}'s exec tool for local tools, including plugins and agents. Start every outer exec code with this exact first line:\n// onecode-session: ${key}\nThen put the requested JavaScript on the next line. Before an unfamiliar tool call, inspect ALL_TOOLS.find(tool => tool.name === "the_tool").inputSchema and use its declared arguments. Nested tools inherit this local session authorization. Workers may finish with await tools.agents({action:"finish",result:"your verified report"}) as their last nested call, after awaiting all earlier tools. For a direct native call (required for session_finish), supply onecode_session_key="${key}" instead. This replaces older task credentials; never print it, copy it to another chat, or invent conversation/request IDs. If this session authorization is missing, revoked or rejected, stop and let OneCode reconcile this exact task and receipt. An argument or path validation error that explicitly says nothing ran is different: inspect the schema and correct that rejected input before execution. Shell commands cannot use app virtual paths: use workdir with relative filenames or an approved native path. Never replay a mutation whose execution is uncertain.`;
  }
  async function status(grant: Grant): Promise<LocalBindingStatus> {
    if (!ready || grants.get(grant.digest)?.id !== grant.id) return { state: 'invalid' };
    let result: LocalBindingStatus;
    if (grant.proof.kind === 'goal') {
      if (provider !== 'claude' || !isChatProviderConversationId(grant.proof.conversationId, provider)) return { state: 'invalid' };
      const { isChatBlocked } = await import('./blocked-chats.js');
      if (isChatBlocked(grant.proof.conversationId)) return { state: 'blocked' };
      const observed = await (await import('../goal.js')).geminiGoalBindingStatus(grant.proof.goal, grant.proof.conversationId, grant.proof.sessionId);
      result = observed.state === 'ready' ? { ...observed, conversationId: grant.proof.conversationId, sessionId: grant.proof.sessionId } : observed;
    } else result = grant.proof.kind === 'input'
      ? provider === 'chatgpt' ? await (await import('./input.js')).chatgptInputBindingStatus(grant.proof.input) : await (await import('./input.js')).localInputBindingStatus(grant.proof.input, provider)
      : provider === 'chatgpt' ? await (await import('../bridge.js')).chatgptCommandBindingStatus(grant.proof) : await (await import('../bridge.js')).localCommandBindingStatus(grant.proof, provider);
    if (result.state !== 'ready') return result;
    if (!isChatProviderConversationId(result.conversationId, provider)) return { state: 'invalid' };
    const { conversationAttachment, findSessionByConversation } = await import('./store.js');
    const attachment = await conversationAttachment(result.conversationId, result.sessionId);
    if (attachment === 'superseded') return { state: 'invalid' };
    if (attachment !== 'current') return { state: 'unresolved' };
    // A non-unique or temporarily unavailable catalog proves no caller identity,
    // but it does not prove the original receipt was revoked. Refuse execution
    // while retaining the exact grant for a later unambiguous recheck.
    if ((await findSessionByConversation(result.conversationId, { requireUnique: true }))?.id !== result.sessionId)
      return { state: 'unresolved' };
    if (!ready || grants.get(grant.digest)?.id !== grant.id) return { state: 'invalid' };
    return result;
  }
  const sameTurn = (a?: GeminiInputTurn, b?: GeminiInputTurn) => JSON.stringify(a) === JSON.stringify(b);
  function isCurrent(evidence: BrowserBindingEvidence): boolean {
    return evidence.attribution === attribution && ready && [...grants.values()].some(grant => grant.id === evidence.bindingId &&
      grant.activated?.conversationId === evidence.conversationId && grant.activated.sessionId === evidence.sessionId &&
      sameTurn(grant.activated.inputTurn, evidence.inputTurn));
  }
  async function validate(evidence: BrowserBindingEvidence): Promise<void> {
    if (evidence.attribution !== attribution) fail('provider-mismatch');
    const grant = [...grants.values()].find(row => row.id === evidence.bindingId);
    if (!grant) fail();
    const current = await status(grant!);
    if (current.state !== 'ready' || current.conversationId !== evidence.conversationId ||
        current.sessionId !== evidence.sessionId || !sameTurn(current.turn, evidence.inputTurn)) fail();
  }
  async function validateReceipt(evidence: BrowserBindingEvidence): Promise<void> {
    // Receipt settlement grants no execution, but still requires the same grant incarnation.
    const { isChatBlocked } = await import('./blocked-chats.js');
    if (!isCurrent(evidence) || isChatBlocked(evidence.conversationId)) fail();
    const { conversationAttachment } = await import('./store.js');
    if (await conversationAttachment(evidence.conversationId, evidence.sessionId) !== 'current') fail();
    if (!isCurrent(evidence) || isChatBlocked(evidence.conversationId)) fail();
  }
  /** Strip the credential before SDK validation, execution, recording or diagnostics. */
  async function authenticate(name: unknown, args: unknown): Promise<{ args: unknown; evidence?: BrowserBindingEvidence }> {
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      if (provider === 'claude') fail('credential-shape');
      return { args };
    }
    const input = args as Record<string, unknown>;
    const code = typeof input.code === 'string' ? input.code : '';
    const hasKey = Object.prototype.hasOwnProperty.call(input, 'onecode_session_key');
    if (!hasKey && !code.startsWith('// onecode-session:')) {
      if (provider === 'claude') fail('credential-unknown');
      return { args };
    }
    if (!ready) await init();
    if (mcpProvider() !== provider) fail('provider-mismatch');
    const match = code.startsWith('// onecode-session:') ? PREFIX.exec(code) : null;
    if ((code.startsWith('// onecode-session:') && (name !== 'exec' || !match)) ||
        (hasKey && (typeof input.onecode_session_key !== 'string' || !/^sk-onecode-session-[A-Za-z0-9_-]{43}$/.test(input.onecode_session_key))) ||
        (match && hasKey && match[1] !== input.onecode_session_key)) fail('credential-shape');
    const grant = grants.get(digest((hasKey ? input.onecode_session_key : match![1]) as string));
    if (!grant) fail('credential-unknown');
    const deadline = performance.now() + INPUT_RECEIPT_WAIT_MS;
    for (;;) {
      const current = await status(grant!);
      if (current.state === 'invalid') { await retireInvalid(grant!); fail('proof-invalid'); }
      // Block is a reversible policy fence, not proof that the task receipt vanished.
      // Refuse immediately without deleting the grant or dispatching a tool.
      if (current.state === 'blocked') fail('blocked');
      if (current.state === 'unresolved') fail('proof-unavailable');
      if (current.state === 'ready') {
        const stripped = { ...input };
        delete stripped.onecode_session_key;
        if (match) stripped.code = code.slice(match[0].length);
        const evidence: BrowserBindingEvidence = {
        bindingId: grant!.id, conversationId: current.conversationId, sessionId: current.sessionId,
        attribution, ...(current.turn ? { inputTurn: current.turn } : {})
        };
        if (grant!.activated && JSON.stringify(grant!.activated) !== JSON.stringify(evidence)) fail('activation-changed');
        await serialized(async () => {
          const live = grants.get(grant!.digest);
          if (!live) fail();
          if (live!.id !== grant!.id || JSON.stringify(live!.proof) !== JSON.stringify(grant!.proof)) fail();
          if (live!.activated && JSON.stringify(live!.activated) !== JSON.stringify(evidence)) fail();
          if (!live!.activated) { const next = new Map(grants); next.set(live!.digest, { ...live!, activated: evidence }); await commit(next); }
        });
        return { args: stripped, evidence };
      }
      if (performance.now() >= deadline) fail('receipt-pending');
      await new Promise(resolve => setTimeout(resolve, 40));
    }
  }
  function reset(): void {
    grants.clear(); ready = false; initInFlight = null; lastInitAttemptAt = 0; tail = Promise.resolve(); retirementCursor = 0;
  }

  return { init, instructions, hasCurrent, isCurrent, validate, validateReceipt, authenticate, reset };
}
const owners = { chatgpt: createLocalBindingOwner('chatgpt'), claude: createLocalBindingOwner('claude') };
const evidenceOwner = (evidence: BrowserBindingEvidence) => owners[evidence.attribution === 'claude_session_capability' ? 'claude' : 'chatgpt'];
/** Preserve the legacy default; startup independently initializes every capability provider. */
export function initLocalBindings(provider: LocalCapabilityProvider = 'chatgpt'): Promise<void> { return owners[provider].init(); }
export function localBindingInstructions(provider: LocalCapabilityProvider, proof: LocalBindingProof): Promise<string> { return owners[provider].instructions(proof); }
export function hasCurrentLocalBinding(provider: LocalCapabilityProvider, text: string, proof: LocalBindingProof): boolean { return owners[provider].hasCurrent(text, proof); }
export function authenticateLocalExec(provider: LocalCapabilityProvider, name: unknown, args: unknown): Promise<{ args: unknown; evidence?: BrowserBindingEvidence }> { return owners[provider].authenticate(name, args); }
export function chatgptBindingInstructions(proof: ChatgptBindingProof): Promise<string> { return localBindingInstructions('chatgpt', proof); }
export function hasCurrentChatgptBinding(text: string, proof: ChatgptBindingProof): boolean { return hasCurrentLocalBinding('chatgpt', text, proof); }
export async function authenticateChatgptExec(name: unknown, args: unknown): Promise<{ args: unknown; evidence?: ChatgptBindingEvidence }> {
  return await authenticateLocalExec('chatgpt', name, args) as { args: unknown; evidence?: ChatgptBindingEvidence };
}
export function localBindingIsCurrent(evidence: LocalBindingEvidence): boolean {
  return evidence.attribution === 'gemini_session_capability' ? geminiBindingIsCurrent(evidence) : evidenceOwner(evidence).isCurrent(evidence);
}
export function validateLocalBinding(evidence: LocalBindingEvidence): Promise<void> {
  return evidence.attribution === 'gemini_session_capability' ? validateGeminiBindingEvidence(evidence) : evidenceOwner(evidence).validate(evidence);
}
export function validateLocalBindingReceipt(evidence: LocalBindingEvidence): Promise<void> {
  return evidence.attribution === 'gemini_session_capability' ? validateGeminiBindingReceiptEvidence(evidence) : evidenceOwner(evidence).validateReceipt(evidence);
}
export function resetLocalBindingsForTests(): void { for (const owner of Object.values(owners)) owner.reset(); }
