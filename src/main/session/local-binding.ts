/**
 * A cached ChatGPT connector may omit native request correlation. An app-authored
 * input/worker command can instead carry an opaque local capability through exec.
 * This cache owns no chat identity: every admission rechecks the original outbox or
 * command receipt, current attachment and turn. Restart deliberately invalidates it.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { GeminiBindingEvidence, GeminiBindingInput, GeminiInputTurn } from '../gemini/bindings.js';
import { GeminiBindingError, geminiBindingIsCurrent, validateGeminiBindingEvidence, validateGeminiBindingReceiptEvidence } from '../gemini/bindings.js';
import { mcpProvider } from '../mcp/provider-context.js';
import { configuredConnectorName } from '../mcp/surfaces.js';
import { getConfig } from '../config.js';
import { INPUT_RECEIPT_WAIT_MS } from '../../shared/input.js';

export interface ChatgptBindingEvidence {
  bindingId: string;
  conversationId: string;
  sessionId: string;
  attribution: 'chatgpt_session_capability';
  inputTurn?: GeminiInputTurn;
  handoff?: never;
}
export type LocalBindingEvidence = GeminiBindingEvidence | ChatgptBindingEvidence;
export type LocalBindingStatus = { state: 'pending' | 'invalid' } |
  { state: 'ready'; conversationId: string; sessionId: string; turn?: GeminiInputTurn };
export type ChatgptBindingProof = { kind: 'input'; input: GeminiBindingInput } |
  { kind: 'command'; id: string; owner: string; lease: string };
type Grant = { id: string; digest: string; proof: ChatgptBindingProof; expiresAt: number; activated?: ChatgptBindingEvidence };
const grants = new Map<string, Grant>();
const digest = (key: string) => createHash('sha256').update(key).digest('hex');
const PREFIX = /^\/\/ onecode-session: (sk-onecode-session-[A-Za-z0-9_-]{43})\r?\n/;
const LIFETIME = 6 * 60 * 60_000;
const fail = (): never => { throw new GeminiBindingError('CHATGPT_SESSION_NOT_AUTHORIZED'); };

/** Preparation may reuse frozen text only while its exact unsent claim still
 * owns the embedded process-local credential. This never authorizes execution. */
export function hasCurrentChatgptBinding(text: string, proof: ChatgptBindingProof): boolean {
  const keys = [...text.matchAll(/^\/\/ onecode-session: (sk-onecode-session-[A-Za-z0-9_-]{43})\r?$/gm)];
  return keys.some(match => {
    const grant = grants.get(digest(match[1]!));
    return !!grant && grant.expiresAt > Date.now() && JSON.stringify(grant.proof) === JSON.stringify(proof);
  });
}

/** Called only inside the paired outbox/command claim owner, never by an MCP tool. */
export function chatgptBindingInstructions(proof: ChatgptBindingProof): string {
  for (const [key, grant] of grants) if (grant.expiresAt <= Date.now()) grants.delete(key);
  if (grants.size >= 20_000) throw new Error('Local session capability limit reached');
  const key = `sk-onecode-session-${randomBytes(32).toString('base64url')}`;
  const grant = { id: randomUUID(), digest: digest(key), proof: structuredClone(proof), expiresAt: Date.now() + LIFETIME };
  grants.set(grant.digest, grant);
  if (getConfig().mcp.useChatgptWebSkill === true) return `Use the installed onecode-chatgpt skill with ${configuredConnectorName('core')}. For this exact app-authored task, use that Core connector's exec tool for ordinary OneCode local tools, including plugins, plans and agents; nested tools inside exec inherit this local session authorization. Fresh authorization for this exact task: start every outer exec code with this first line:
// onecode-session: ${key}
Then JavaScript. Do not make a direct OneCode tool call unless its current schema accepts onecode_session_key; without the fresh key it is Unattributed. Direct native calls that require it, including session_finish, use onecode_session_key="${key}". This replaces older credentials. Never print or copy the key. If authorization is rejected, stop and request a fresh OneCode message; never replay an uncertain mutation.`;
  return `For this exact app-authored task, use ${configuredConnectorName('core')}'s exec tool for local tools, including plugins and agents. Start every outer exec code with this exact first line:\n// onecode-session: ${key}\nThen put the requested JavaScript on the next line. Before an unfamiliar tool call, inspect ALL_TOOLS.find(tool => tool.name === "the_tool").inputSchema and use its declared arguments. Nested tools inherit this local session authorization. Workers may finish with await tools.agents({action:"finish",result:"your verified report"}) as their last nested call, after awaiting all earlier tools. For a direct native call (required for session_finish), supply onecode_session_key="${key}" instead. This replaces older task credentials; never print it, copy it to another chat, or invent conversation/request IDs. If this session authorization is missing, expired, revoked or rejected, stop and ask OneCode to send a fresh message. An argument or path validation error that explicitly says nothing ran is different: inspect the schema and correct that rejected input before execution. Shell commands cannot use app virtual paths: use workdir with relative filenames or an approved native path. Never replay a mutation whose execution is uncertain.`;
}
async function status(grant: Grant): Promise<LocalBindingStatus> {
  if (grants.get(grant.digest) !== grant || grant.expiresAt <= Date.now()) return { state: 'invalid' };
  const result = grant.proof.kind === 'input'
    ? await (await import('./input.js')).chatgptInputBindingStatus(grant.proof.input)
    : await (await import('../bridge.js')).chatgptCommandBindingStatus(grant.proof);
  if (result.state !== 'ready') return result;
  const { conversationAttachment, findSessionByConversation } = await import('./store.js');
  if (await conversationAttachment(result.conversationId, result.sessionId) !== 'current' ||
      (await findSessionByConversation(result.conversationId, { requireUnique: true }))?.id !== result.sessionId ||
      grants.get(grant.digest) !== grant || grant.expiresAt <= Date.now()) return { state: 'invalid' };
  return result;
}
const sameTurn = (a?: GeminiInputTurn, b?: GeminiInputTurn) => JSON.stringify(a) === JSON.stringify(b);
export function localBindingIsCurrent(evidence: LocalBindingEvidence): boolean {
  if (evidence.attribution === 'gemini_session_capability') return geminiBindingIsCurrent(evidence);
  return [...grants.values()].some(grant => grant.id === evidence.bindingId && grant.expiresAt > Date.now() &&
    grant.activated?.conversationId === evidence.conversationId && grant.activated.sessionId === evidence.sessionId &&
    sameTurn(grant.activated.inputTurn, evidence.inputTurn));
}
export async function validateLocalBinding(evidence: LocalBindingEvidence): Promise<void> {
  if (evidence.attribution === 'gemini_session_capability') return validateGeminiBindingEvidence(evidence);
  const grant = [...grants.values()].find(row => row.id === evidence.bindingId);
  if (!grant) fail();
  const current = await status(grant!);
  if (current.state !== 'ready' || current.conversationId !== evidence.conversationId ||
      current.sessionId !== evidence.sessionId || !sameTurn(current.turn, evidence.inputTurn)) fail();
}
export async function validateLocalBindingReceipt(evidence: LocalBindingEvidence): Promise<void> {
  if (evidence.attribution === 'gemini_session_capability') return validateGeminiBindingReceiptEvidence(evidence);
  // Receipt settlement grants no execution, but still requires the same grant incarnation.
  if (!localBindingIsCurrent(evidence)) fail();
  const { conversationAttachment } = await import('./store.js');
  if (await conversationAttachment(evidence.conversationId, evidence.sessionId) !== 'current') fail();
}
/** Strip the credential before SDK validation, execution, recording or diagnostics. */
export async function authenticateChatgptExec(name: unknown, args: unknown): Promise<{ args: unknown; evidence?: ChatgptBindingEvidence }> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { args };
  const input = args as Record<string, unknown>;
  const code = typeof input.code === 'string' ? input.code : '';
  const hasKey = Object.prototype.hasOwnProperty.call(input, 'onecode_session_key');
  if (!hasKey && !code.startsWith('// onecode-session:')) return { args };
  if (mcpProvider() !== 'chatgpt') fail();
  const match = code.startsWith('// onecode-session:') ? PREFIX.exec(code) : null;
  if ((code.startsWith('// onecode-session:') && (name !== 'exec' || !match)) ||
      (hasKey && (typeof input.onecode_session_key !== 'string' || !/^sk-onecode-session-[A-Za-z0-9_-]{43}$/.test(input.onecode_session_key))) ||
      (match && hasKey && match[1] !== input.onecode_session_key)) fail();
  const grant = grants.get(digest((hasKey ? input.onecode_session_key : match![1]) as string));
  if (!grant) fail();
  const deadline = performance.now() + INPUT_RECEIPT_WAIT_MS;
  for (;;) {
    const current = await status(grant!);
    if (current.state === 'invalid') fail();
    if (current.state === 'ready') {
      const stripped = { ...input };
      delete stripped.onecode_session_key;
      if (match) stripped.code = code.slice(match[0].length);
      const evidence: ChatgptBindingEvidence = {
      bindingId: grant!.id, conversationId: current.conversationId, sessionId: current.sessionId,
      attribution: 'chatgpt_session_capability', ...(current.turn ? { inputTurn: current.turn } : {})
      };
      if (grant!.activated && JSON.stringify(grant!.activated) !== JSON.stringify(evidence)) fail();
      grant!.activated = evidence;
      return { args: stripped, evidence };
    }
    if (performance.now() >= deadline) fail();
    await new Promise(resolve => setTimeout(resolve, 40));
  }
}
export function resetLocalBindingsForTests(): void { grants.clear(); }
