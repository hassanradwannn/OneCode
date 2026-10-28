import { REASONING_EFFORTS, workSequence } from '../../shared/session.js';
/** User-authored input has one durable owner across browser and MCP delivery.
 * A claimed browser send is never automatically retried: losing the ACK is ambiguous.
 * Tool delivery repeats under a stable message id until a later request proves receipt.
 */
import { z } from 'zod';
import { browserInputModel, manualInput, queuedFollowup, MAX_INPUT_IMAGES, type InputImage, type QueuedInputNowIntent } from '../../shared/input.js';
import type { SessionSummary } from '../../shared/session.js';
import { getConfig } from '../config.js';
import { geminiBindingsEnabled, type GeminiBindingInput, type GeminiInputTurn } from '../gemini/bindings.js';
import { chatgptBindingInstructions, hasCurrentChatgptBinding, validateLocalBinding, validateLocalBindingReceipt, type LocalBindingEvidence, type LocalBindingStatus } from './local-binding.js';
import { positionOf } from '../../shared/chronology.js';
import { randomUUID } from 'node:crypto';
import { CHAT_PROVIDERS, DEFAULT_CHAT_PROVIDER, providerTrustValidationEnabled, chatProviderCapabilities, chatProviderForConversation, type ChatProvider } from '../../shared/chat-provider.js';
import { userTitle } from './title.js';
import { readDurable, writeDurableNow, writeDurableSoon } from '../durable.js';
import { getSession, findSessionByConversation, createSession, deleteSession, rebindSession, conversationWasSuperseded, readRecentEvents, listUsageSessions, turnHasMcpCall, questionHasMcpCall, sessionDirectoryMissing, readCompletedFinal, readLatestUserMessage } from './store.js';
import { assignSessionProject, getProject, projectWorkspace, getSessionProject } from '../projects.js';
import { isChatBlocked } from './blocked-chats.js';
import { wakeBrowserWork } from '../browser-wake.js';
import { logInfo, logWarn } from '../logger.js';
import { noteChatOrigin } from './recorder.js';
import { DEFAULT_HELPER_CHAT_MODEL, isAstraModel, isProModel } from '../../shared/chat-models.js';
import { inFlightToolCalls, runningToolProgress } from '../mcp/call-context.js';
import { automaticFinishEnabled, goalDrivingMode, consumeGoalReplyForInputNow } from '../goal.js';
import { finishInstruction } from '../../shared/finish.js';
import { CONVERSATION_DELETED } from '../../shared/chat-error.js';
import { attachmentSchema, validateInputAttachments, normalizeInputAttachments } from './input-attachments.js';
import { MAX_BROWSER_MESSAGE_CHARS } from '../../shared/user-prompt.js';
import type { PromptLimits } from './prompt.js';
import { BROWSER_PICKUP_MAX_ATTEMPTS, recoveryMessage, recoveryBusyMs, rotationMessage } from '../../shared/recovery.js';
import { invokedSkills } from '../../shared/skill-invocation.js';
import { SKILL_ID_PATTERN } from '../../shared/skills.js';
import { autoSelectManagedSkills } from '../skill-routing.js';
import { asksForImage } from './image-request.js';

export const inputArgs = z.object({
  provider: z.enum(CHAT_PROVIDERS).optional(),
  /** Explicit native composer Steer for this exact turn; never tool-result injection. */
  steerTurnId: z.string().min(1).max(256).optional(),
  projectId: z.string().uuid().nullable().optional(),
  automation: z.enum(['off', 'goal', 'loop']).optional(),
  loopAfterTurn: z.boolean().optional(),
  objective: z.string().trim().max(16000).optional(),
  /** Which existing field holds the human request, before generated workflow wrapping. */
  authoredSource: z.enum(['text', 'objective', 'none']).optional(),
  stages: z.array(z.string().trim().min(1).max(16000)).max(11).optional(),
  images: z.array(z.object({ name: z.string().min(1).max(110), dataUrl: z.string().max(512100).regex(/^data:image\/webp;base64,[A-Za-z0-9+/]+={0,2}$/) })).max(MAX_INPUT_IMAGES).optional(),
  attachments: z.array(attachmentSchema).max(20).optional(),
  /** User selected the next exact local-tool response, even before the first call. */
  delivery: z.literal('tool').optional(),
  attachmentDelivery: z.literal('tool').optional(),
  id: z.string().uuid(),
  sessionId: z.string().min(8).max(64).nullable(),
  text: z.string().trim().min(1).max(MAX_BROWSER_MESSAGE_CHARS),
  mode: z.enum(['auto', 'after-turn', 'finish']),
  afterTurn: z.boolean().optional(),
  dueAt: z.number().int().nonnegative(),
  model: z.string().max(80).nullable(),
  reasoningEffort: z.enum(REASONING_EFFORTS).nullable()
});
export type InputArgs = z.infer<typeof inputArgs>;
/** One refresh of an already-sent tool-free Gemini warmup, never task Send authority. */
export const warmupRecoverySchema = z.object({
  spent: z.literal(true), questionId: z.string().min(1).max(256).nullable(), at: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(), browser: z.string().regex(/^[a-z0-9]{16,64}$/), tab: z.number().int().nonnegative(),
  document: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), owner: z.string().min(1).max(160),
  successorOwner: z.string().min(1).max(160).optional(), successorDocument: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
  conversationId: z.string().regex(/^[a-f0-9]{16}$/).optional(),
  initialization: z.object({ at: z.number().int().nonnegative() }).strict().optional()
}).strict().refine(r => r.expiresAt > r.at && !!r.successorOwner === !!r.successorDocument &&
  (!r.initialization || r.initialization.at >= r.at && r.initialization.at < r.expiresAt));
export type WarmupRecovery = z.infer<typeof warmupRecoverySchema>;
export type WarmupDocument = { tab_id: number; document_id: string };
export function warmupRecoveryView(r: WarmupRecovery) {
  return { spent: true as const, questionId: r.questionId, at: r.at, expiresAt: r.expiresAt,
    ...(r.initialization ? { initialization: { at: r.initialization.at } } : {}) };
}
/** Callers commit this reservation before allowing one tool-free successor initialization. */
export function reserveWarmupInitialization(r: WarmupRecovery, owner: string, browser: string,
  source: WarmupDocument): WarmupRecovery | null {
  const now = Date.now();
  if (r.initialization || r.conversationId || now < r.at || now >= r.expiresAt || r.browser !== browser ||
      r.tab !== source.tab_id || r.successorOwner !== owner || r.successorDocument !== source.document_id ||
      owner === r.owner || source.document_id === r.document) return null;
  return { ...r, initialization: { at: now } };
}
/** Native question IDs can change on reload; only the exact paired tab/document chain transfers. */
export function adoptWarmupRecovery(r: WarmupRecovery, owner: string, browser: string | null,
  source: WarmupDocument | undefined, conversationId: string | null): WarmupRecovery | null {
  if (!source || browser !== r.browser || source.tab_id !== r.tab || Date.now() >= r.expiresAt ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(source.document_id) ||
      (conversationId !== null && !/^[a-f0-9]{16}$/.test(conversationId)) ||
      (r.conversationId && conversationId !== null && r.conversationId !== conversationId)) return null;
  const original = source.document_id === r.document && owner === r.owner;
  if (original ? !conversationId : source.document_id === r.document || owner === r.owner) return null;
  if (r.successorOwner && (r.successorOwner !== owner || r.successorDocument !== source.document_id)) return null;
  return { ...r, successorOwner: owner, successorDocument: source.document_id,
    ...(conversationId ? { conversationId } : {}) };
}
const entrySchema = inputArgs.extend({
  /** Saved interval authority; only the scheduler's internal admission supplies this. */
  scheduleId: z.string().uuid().optional(),
  steerReady: z.literal(true).optional(),
  steerClosedOnce: z.literal(true).optional(),
  warmupRecovery: warmupRecoverySchema.optional(),
  /** Ordered recovery remains on the original input; navigation never refunds Send. */
  nativeRecovery: z.object({ turnId: z.string().min(1).max(256), questionId: z.string().min(1).max(256),
    phase: z.enum(['ready-to-refresh', 'refresh-dispatched', 'ready']), refreshOwner: z.string().optional() }).optional(),
  /** This exact outbox row owns the first native send of its reserved local session. */
  opening: z.literal(true).optional(),
  /** An explicit retry can keep its unbound local chat instead of reserving another. */
  requestedSessionId: inputArgs.shape.sessionId.optional(),
  /** Provider captured at local admission; changing the new-chat selector cannot retarget queued work. */
  chatProvider: z.enum(CHAT_PROVIDERS).optional(),
  /** Frozen automatic routing decision. Empty means routing ran and deliberately chose none. */
  autoSkills: z.array(z.object({ id: z.string().regex(SKILL_ID_PATTERN), revision: z.string().regex(/^[0-9a-f]{64}$/i) }).strict()).max(1).optional(),
  /** Frozen image projection; authored attachment IDs remain the replay identity. */
  toolImages: inputArgs.shape.images,
  /** One after-turn pickup earned by confirmed silence or settled Thinking failed. */
  silenceBoundary: z.object({ turnId: z.string().min(1).max(256), conversationId: z.string().min(1).max(256), workSeq: z.number().int().nonnegative(), acceptedAt: z.number().nonnegative().optional(), listenUntil: z.number().nonnegative().optional(), nativeBusy: z.boolean().optional() }).optional(),
  /** The active turn at admission; its final may already be waiting in the browser journal. */
  queuedTurn: z.object({ conversationId: z.string().min(1).max(256), turnId: z.string().min(1).max(256) }).optional(),
  /** Shared unfinished-response fallback belongs to this question in every mode. */
  recovery: z.object({ questionId: z.string(), episode: z.string().max(200).optional(), pro: z.boolean(), busyUntil: z.number(), phase: z.enum(['ready', 'stopping', 'reloading', 'resumed']), reloadOwner: z.string().optional(),
    stopOwner: z.string().optional(), closedOnce: z.literal(true).optional(),
    /** First release of an unbroken run of pages withdrawing this Continue before Send (#820). */
    withdrawnSince: z.number().optional(),
    /** A page refused this Continue before claiming it, so it ended unsent; see endRecoveryInput. */
    ended: z.literal('page-final').optional() }).optional(),
  /** Exact native turn this browser correction may join. New explicit Steer freezes its source question too. */
  directTurn: z.object({ id: z.string().min(1).max(256), startedAt: z.number(), questionId: z.string().min(1).max(256).optional() }).optional(),
  finishOwner: z.object({ turnId: z.string().min(1).max(256), periodic: z.boolean(), mode: z.enum(['goal', 'loop']).optional(), userRequested: z.boolean().optional() }).optional(),
  requestedMode: z.enum(['auto', 'after-turn', 'finish']).optional(),
  transportIntent: z.enum(['tool', 'browser']).optional(),
  text: z.string().min(1).max(240000),
  deliveryText: z.string().min(1).max(240000).optional(),
  /** One checkpoint shares this browser send and its receipt with the user's correction. */
  companionInputId: z.string().uuid().optional(),
  /** `rotation`: the app's automatic continue that starts a fresh turn in a long one (#1402). */
  purpose: z.enum(['user', 'decision', 'rotation']).optional(),
  lifetime: z.literal('temporary-planner').optional(),
  decisionSourceSessionId: z.string().min(8).max(64).optional(),
  response: z.string().max(16000).optional(),
  state: z.enum(['queued', 'browser', 'tool', 'sent', 'cancelled', 'failed', 'decision']),
  offeredAt: z.number().optional(),
  /** Tool-result corrections remain inside their original generation in history. */
  toolTurnId: z.string().min(1).max(256).optional(),
  /** Local offer evidence only, never a Google request/generation identifier. */
  toolGeminiOffer: z.object({ attribution: z.enum(['gemini_session_capability', 'chatgpt_session_capability']).optional(), bindingId: z.string().min(1).max(64), startedAt: z.number().nonnegative(),
    inputTurn: z.object({ inputId: z.string().uuid(), messageId: z.string().min(1).max(256),
      historySeq: z.number().int().positive(), turnId: z.string().min(1).max(256) }).optional() }).optional(),
  /** Explicit live Steer may not borrow a retained MCP window after native turn end. */
  toolSteer: z.literal(true).optional(),
  sendAuthorizedAt: z.number().optional(),
  requiresAuthorization: z.boolean().optional(),
  /** A browser pickup timeout is safely replayable only before Send authorization. */
  pickupFailedAt: z.number().optional(),
  /** Main-policy hold pauses only an immediate message's unclaimed pickup clock. */
  pickupHeldAt: z.number().optional(),
  /** One preparation attempt can yield without ending the durable instruction. */
  preparationWait: z.object({ reason: z.enum(['provider-page', 'answer-resumed', 'editor-unavailable', 'document-rebind']),
    since: z.number(), attempts: z.number().int().positive() }).optional(),
  /** One automatic retry is permitted for an exact, never-authorized browser pickup. */
  pickupRetryCount: z.number().int().nonnegative().optional(),
  /** Times a Send the page proved untaken (its exact text still in the composer) was requeued. */
  notTakenRetries: z.number().int().nonnegative().optional(),
  /** Browser reload budget for this exact queued input; survives app restart. */
  pickupRecovery: z.object({ attempts: z.number().int().min(0).max(BROWSER_PICKUP_MAX_ATTEMPTS),
    nextAt: z.number().int().positive().optional(), stoppedAt: z.number().int().positive().optional() }).optional(),
  cancelledByUser: z.literal(true).optional(),
  error: z.string().max(200).optional(),
  owner: z.string().nullable(),
  /** The paired browser that obtained this exact durable claim; not a model-supplied field. */
  claimedBrowser: z.string().regex(/^[a-z0-9]{16,64}$/).optional(),
  createdAt: z.number(),
  conversationId: z.string().nullable(),
  deliveredSessionId: z.string().min(8).max(64).nullable().optional(),
  messageId: z.string().min(1).max(256).optional(),
  deliveredAt: z.number().optional(),
  failedAt: z.number().optional(),
  noticeDismissedAt: z.number().optional(),
  stagesApplied: z.boolean().optional(),
  historyRecorded: z.boolean().optional(),
  /** Canonical message exists even when optional image assets could not be saved. */
  historyAnchored: z.boolean().optional(),
  /** Store origin proving the canonical row was committed; never a wall-clock guess. */
  historySeq: z.number().int().positive().optional(),
  completedTurnId: z.string().max(256).optional(),
  queueOrder: z.number().int().nonnegative().optional()
});
export type InputEntry = z.infer<typeof entrySchema>;
/** Explicit browser text, including the user's After this turn choice. Generated
 * checkpoints, schedules, recovery and tool handouts keep their separate barriers. */
function authoredBrowserInput(entry: InputArgs & Partial<Pick<InputEntry, 'purpose' | 'finishOwner' | 'scheduleId' | 'recovery' | 'silenceBoundary'>>): boolean {
  return (manualInput(entry) || (entry.mode === 'after-turn' && entry.purpose !== 'decision' && entry.purpose !== 'rotation')) &&
    !entry.finishOwner && !entry.scheduleId && !entry.recovery && !entry.silenceBoundary && !entry.stages?.length &&
    entry.delivery !== 'tool' && entry.attachmentDelivery !== 'tool' && (entry.authoredSource ?? 'text') !== 'none';
}
const STATE = 'session-input';
const TOOL_INPUT_TEXT_BYTES = 128000;
/** A confirmed send receipt lands in seconds. This only bounds one that is never reported. */
const UNCERTAIN_SEND_MS = 15 * 60_000;
/** A fresh native Gemini chat must finish its tool-free warmup before task Send. */
const FRESH_OPENING_PREPARATION_MS = 6 * 60_000;
const UNCLAIMED_PICKUP_RETRY_MIN_MS = 2 * 60_000;
const UNCLAIMED_PICKUP_RETRY_MAX_AGE_MS = 30 * 60_000;
/**
 * The same bound for the sends the one above leaves in custody: an automatic Continue, a new
 * chat's first message and a combined delivery. Their own paths normally settle them in seconds
 * to minutes. Measured 2026-09-27, seven such rows had waited in `browser` for up to ten days;
 * each kept its chat protected and told the extension an input was still in flight.
 */
const ABANDONED_SEND_MS = 6 * 60 * 60_000;
const UNCONFIRMED_SEND = 'Stopped waiting for delivery confirmation. The message may already have been sent; it will not be resent.';
/**
 * The page clicked native Send, but no row it could read proved the message arrived (#821: an
 * opening read back with `&#x20;` for spaces). The same code in extension/content.js.
 */
const RECEIPT_UNCONFIRMED = 'Native Send receipt was not confirmed.';
/** The page clicked Send, yet its exact text stayed in the composer and no new user row appeared. */
const SEND_NOT_TAKEN = 'Native Send did not take the message.';
const NOT_TAKEN_FAILED = 'Not sent: the provider did not accept the message.';
export const TOOL_INPUT_HEADER = '\n--- New instructions from the user ---\n';
export interface ToolInputBatch {
  messages: Array<{ text: string; images: InputImage[] }>;
  /** One transport instruction after the complete batch, including its images. */
  reminder: string;
}
export interface InputActivity { possible: boolean; exact: boolean; model?: 'pro' | 'other' | 'unknown'; turnId?: string }
type InputDeliveryHooks = {
  recoveryAllowed?: (sessionId: string, conversationId: string) => boolean;
  /** Whether running calls still hold this chat's automatic Continue; without it, any call does. */
  callsHoldRecovery?: (conversationId: string) => boolean;
  activity?: (session: SessionSummary) => InputActivity;
  wakeDecision?: (entry: Readonly<InputEntry>, signal: AbortSignal) => Promise<void>;
  bindHelper?: (conversationId: string, sourceSessionId: string | null) => Promise<void>;
  /** Trust an exact CoS composer opening under the same session-policy fence as Trust IPC. */
  trustOpening?: (sessionId: string, conversationId: string) => Promise<boolean>;
  recordDelivered?: (entry: Readonly<InputEntry>, anchorCommitted: (seq: number) => void) => Promise<boolean>;
  prepareText?: (entry: Readonly<InputEntry>, limits: PromptLimits, authored: string, routingInstructions?: string) => string | Promise<string>;
  applyAutomation: (conversationId: string, automation: NonNullable<InputArgs['automation']>, phase: 'before-send' | 'after-send', objective?: string, loopAfterTurn?: boolean) => Promise<void>;
  changed: () => void;
};
let deliveryHooks: InputDeliveryHooks | null = null;
const geminiInput = (conversationId: string | null | undefined): boolean =>
  geminiBindingsEnabled() && chatProviderForConversation(conversationId) === 'gemini';
/** Installed once by IPC before bridge/MCP startup; avoids a Goal/input import cycle. */
export function configureInputDelivery(hooks: InputDeliveryHooks): void { deliveryHooks = hooks; }
/** One delivery policy for composer presentation, admission and the final send fence. */
export async function sessionInputPolicy(sessionId: string, observedActivity?: InputActivity, authoredAt?: number): Promise<{ queueAtFinish: boolean; canInject: boolean; injectionTurnId: string | null; directTurn: InputEntry['directTurn'] | null; browserAllowed: boolean; settled: boolean }> {
  const [end] = await readRecentEvents(sessionId, 1, { kinds: ['turn_start', 'turn_end'] });
  const session = await getSession(sessionId);
  if (!session?.conversationId || isChatBlocked(session.conversationId)) return { queueAtFinish: false, canInject: false, injectionTurnId: null, directTurn: null, browserAllowed: false, settled: false };
  const activity = observedActivity ?? deliveryHooks?.activity?.(session) ?? { possible: !!session.activeTurnId, exact: !!session.activeTurnId };
  const stopped = session.finishTurn?.released === true;
  const selection = session.selectedModel?.conversationId === session.conversationId ? session.selectedModel : null;
  // Ordinary automatic delivery retains its measured ChatGPT policy (#1231).
  // Explicit Steer has separate exact-turn custody and asks either provider's
  // native composer to accept it; attachments keep their existing transport.
  const directTurn = !geminiInput(session.conversationId) && !stopped && activity.exact && end?.kind === 'turn_start' &&
    !!end.turnId && end.turnId === session.activeTurnId && !!selection?.model &&
    // The observed selection belongs to this exact chat. An activity renewal
    // without its own model label cannot revoke immediate delivery mid-turn.
    // A positive Pro observation still fences this native composer path.
    activity.model !== 'pro' && activity.model !== 'unknown' &&
    !isProModel(selection.model, selection.reasoningEffort)
    ? { id: end.turnId, startedAt: end.time } : null;
  let canInject = !stopped && activity.exact && !directTurn;
  // The bridge's retained exact MCP grant can outlive a native UI end. Project
  // that same turn for image custody, never invent an active recorder turn.
  let injectionTurnId = canInject ? session.activeTurnId ?? (activity.turnId === end?.turnId ? activity.turnId ?? null : null) : null;
  const astra = session.origin?.kind !== 'worker' && session.origin?.kind !== 'helper' &&
    session.selectedModel?.conversationId === session.conversationId && isAstraModel(session.selectedModel.model, session.selectedModel.reasoningEffort);
  const completed = !session.activeTurnId
    ? await readCompletedFinal(sessionId, session.conversationId) : null;
  const terminal = end?.kind === 'turn_end' && !!end.turnId && end.outcome !== 'unknown';
  // A native completed boundary can precede final-message attribution. A soft
  // display/recovery timer alone must not strand a new explicit Gemini follow-up.
  // This does not settle automation; native Send still rechecks actual readiness.
  // Only a new manual message authored after native Stop may bypass the old soft
  // timer. Stop cannot release previously queued automation or an earlier task.
  const authoredAfterStop = authoredAt !== undefined && terminal && end.outcome === 'stopped' && authoredAt > end.time;
  // A new explicit instruction after a recorded failure owns a new native Send.
  // A surviving old poll is not its recipient. Native readiness and the exact
  // new question still guard delivery; earlier queues/automation cannot use it.
  const authoredAfterFailure = authoredAt !== undefined && terminal && end.outcome === 'failed' && authoredAt > end.time;
  const idleCandidate = !session.activeTurnId && !activity.exact && terminal &&
    ((geminiInput(session.conversationId) && end.outcome === 'completed') || authoredAfterStop) &&
    (session.lastToolCallAt ?? 0) <= end.time;
  // An explicit user message may start the next native turn while an exact local
  // poll or retained MCP grant survives the previous answer. Native completion,
  // not local process lifetime, owns that boundary. Automation keeps its existing
  // settled/call fences. An old queued message cannot spend a later explicit Stop.
  const authoredIdleCandidate = authoredAt !== undefined && !session.activeTurnId && terminal &&
    (end.outcome === 'completed' || authoredAfterStop || authoredAfterFailure);
  const [latestQuestion] = idleCandidate || authoredIdleCandidate
    ? await readRecentEvents(sessionId, 1, { kinds: ['user_message'], orderByOrigin: true }) : [];
  const explicitNativeIdle = idleCandidate && (!latestQuestion || (latestQuestion.kind === 'user_message' &&
    (latestQuestion.origin ?? latestQuestion.seq) <= end.seq));
  const authoredNativeIdle = authoredIdleCandidate && (!latestQuestion || (latestQuestion.kind === 'user_message' &&
    (latestQuestion.origin ?? latestQuestion.seq) <= end.seq));
  if (authoredNativeIdle) { canInject = false; injectionTurnId = null; }
  const current = await getSession(sessionId);
  if (current?.conversationId !== session.conversationId || current?.activeTurnId !== session.activeTurnId)
    return { queueAtFinish: false, canInject: false, injectionTurnId: null, directTurn: null, browserAllowed: false, settled: false };
  const settled = (terminal && ((end.outcome === 'completed' && !activity.possible && !activity.exact) ||
    (end.outcome === 'failed' && end.reason === 'thinking_failed'))) ||
    (!astra && !!completed && !activity.possible && !activity.exact);
  // Ordinary authored input follows this chat's actual work. Anonymous calls
  // remain in the global safety barrier, but cannot serialize unrelated chats.
  const executing = runningToolProgress(session.conversationId) !== null;
  return { canInject, injectionTurnId, directTurn, queueAtFinish: astra && canInject && getConfig().ui.finishTool === true,
    // An adopted idle chat may have no recorded turn boundary. Explicit input can
    // use its native composer; queued checkpoints still require `settled` below.
    browserAllowed: authoredNativeIdle || (!session.activeTurnId && (!activity.possible || explicitNativeIdle) && !activity.exact && !executing),
    // Completion already reconciles trailing same-request calls. A separate time
    // comparison would leave the composer unsettled after the activity clock stopped.
    settled: settled && !executing && (!!completed || (session.lastToolCallAt ?? 0) <= (end?.time ?? 0)) };
}
/** Freeze only the actual canonical live task; a retained activity grant is insufficient. */
async function steeringSource(sessionId: string, conversationId: string, turnId: string): Promise<InputEntry['directTurn'] | null> {
  const [boundary] = await readRecentEvents(sessionId, 1, { kinds: ['turn_start', 'turn_end'] });
  const question = await readLatestUserMessage(sessionId);
  const session = await getSession(sessionId);
  return session?.conversationId === conversationId && session.activeTurnId === turnId &&
    boundary?.kind === 'turn_start' && boundary.turnId === turnId && question?.messageId &&
    (question.origin ?? question.seq) <= boundary.seq
    ? { id: turnId, startedAt: boundary.time, questionId: question.messageId } : null;
}
async function browserInputAllowed(entry: InputEntry): Promise<boolean> {
  if (entry.warmupRecovery && Date.now() >= entry.warmupRecovery.expiresAt) return false;
  if (entry.recovery?.phase === 'stopping') return recoveryCurrent(entry);
  if (entry.nativeRecovery && entry.nativeRecovery.phase !== 'ready')
    return entry.nativeRecovery.phase === 'ready-to-refresh' && await inputRefreshCurrent(entry);
  if (entry.steerTurnId) {
    if (!entry.steerReady || !entry.sessionId) return false;
    const session = await getSession(entry.sessionId);
    const [end] = await readRecentEvents(entry.sessionId, 1, { kinds: ['turn_start', 'turn_end'] });
    if (entry.directTurn?.questionId) {
      const question = await readLatestUserMessage(entry.sessionId);
      const current = await getSession(entry.sessionId);
      const exactTurn = current?.activeTurnId === entry.steerTurnId && end?.kind === 'turn_start' && end.turnId === entry.steerTurnId;
      const endedTurn = !current?.activeTurnId && end?.kind === 'turn_end' && end.turnId === entry.steerTurnId &&
        ['completed', 'stopped', 'failed', 'interrupted'].includes(end.outcome);
      return !entry.error?.startsWith('Local chat setup failed:') && entry.directTurn.id === entry.steerTurnId &&
        current?.conversationId === entry.conversationId && question?.messageId === entry.directTurn.questionId &&
        (exactTurn || endedTurn) && !isChatBlocked(entry.conversationId!) && !await conversationWasSuperseded(entry.conversationId!);
    }
    return !!entry.steerReady && !entry.error?.startsWith('Local chat setup failed:') && !session?.activeTurnId && session?.conversationId === entry.conversationId &&
      end?.kind === 'turn_end' && ['completed', 'stopped', 'failed', 'interrupted'].includes(end.outcome) && end.turnId === entry.steerTurnId &&
      !isChatBlocked(entry.conversationId!) && !await conversationWasSuperseded(entry.conversationId!);
  }
  if (entry.error?.startsWith('Local chat setup failed:')) return false;
  // Authored Inject-now custody never changes transports. Its exact turn either
  // offers it from an MCP response or expires it visibly below.
  if (entry.delivery === 'tool') return false;
  if (entry.attachmentDelivery === 'tool') return false;
  if (entry.opening && entry.sessionId && !entry.deliveredAt) {
    const session = await getSession(entry.sessionId);
    if (session?.origin?.kind === 'desktop' && !session.conversationId) return true;
  }
  if (entry.mode === 'finish' && entry.sessionId && entry.afterTurn !== true) {
    const session = await getSession(entry.sessionId);
    const selection = session?.selectedModel;
    if (selection?.conversationId === session?.conversationId && isAstraModel(selection?.model, selection?.reasoningEffort)) return false;
  }
  if (!entry.sessionId) return entry.transportIntent !== 'tool';
  const session = await getSession(entry.sessionId);
  // Departure suspends already accepted delivery through the final Send check.
  // A new explicit immediate message remains a user action that may open the chat.
  if (session?.browserRecoveryDismissedAt !== undefined &&
      (!manualInput(entry) || entry.createdAt <= session.browserRecoveryDismissedAt)) return false;
  // Silence can leave the recorder's original turn open. Its durable ticket
  // proves the exact unchanged work; the native page must still be idle for Send.
  if (entry.silenceBoundary) return await eligibleStageEnd(entry) === entry.silenceBoundary.turnId;
  const newlyAuthored = authoredBrowserInput(entry);
  const policy = await sessionInputPolicy(entry.sessionId, undefined, newlyAuthored ? entry.createdAt : undefined);
  // A saved interval wakes an idle chat independently of a newer completed turn.
  // It still waits for ordinary browser readiness and can never join an MCP result.
  if (entry.scheduleId) return policy.browserAllowed;
  if (entry.completedTurnId && await eligibleStageEnd(entry) !== entry.completedTurnId) return false;
  if (entry.directTurn) {
    const session = await getSession(entry.sessionId);
    if (!session || session.conversationId !== entry.conversationId) return false;
    if (session.activeTurnId) return policy.directTurn?.id === entry.directTurn.id;
    const [end] = await readRecentEvents(entry.sessionId, 1, { kinds: ['turn_start', 'turn_end'] });
    return policy.browserAllowed && end?.kind === 'turn_end' && end.turnId === entry.directTurn.id;
  }
  // Only a never-offered ordinary input may change routes after positive terminal evidence.
  // A tool handout or ambiguous browser claim retains its original exclusive custody.
  return policy.browserAllowed && (entry.transportIntent !== 'tool' ||
    (entry.mode === 'auto' && !entry.finishOwner && entry.purpose !== 'decision' && entry.state === 'queued' &&
      entry.owner === null && entry.offeredAt === undefined && policy.settled));
}
/** The last release reason said out loud per ticket, so a loop is visible without being noisy. */
const recoveryReleaseTold = new Map<string, string>();

const inputListeners = new Set<() => void>();
export function onInputChange(listener: () => void): () => void {
  inputListeners.add(listener);
  return () => { inputListeners.delete(listener); };
}
/** Observation only: the kernel remains the sole tool-input consumer. */
export function hasEligibleToolInput(sessionId: string, finishBoundary = false): Promise<boolean> {
  return serial(async () => {
    const current = ordered(await load());
    if (current.some(row => row.sessionId === sessionId && row.state === 'browser')) return false;
    const head = current.find(row => row.sessionId === sessionId && queuedFollowup(row) && ['queued', 'tool'].includes(row.state));
    const steerSession = current.some(row => row.sessionId === sessionId && row.toolSteer && row.state === 'queued') ? await getSession(sessionId) : null;
    for (const row of current) {
      if (row.sessionId !== sessionId || row.dueAt > Date.now()) continue;
      if (row.steerTurnId) continue;
      if (row.toolSteer && row.state === 'queued' && steerSession?.activeTurnId !== row.toolTurnId) continue;
      if (row.attachments?.length && row.attachmentDelivery !== 'tool' && row.delivery !== 'tool') continue;
      if (row.mode === 'after-turn' || (row.mode === 'finish' && !finishBoundary)) continue;
      if (row.mode === 'finish' && row !== head) continue;
      if (row.state === 'tool') return true;
      if (row.state === 'queued') return row.mode === 'auto' || (finishBoundary && row.mode === 'finish');
    }
    return false;
  });
}
let entries: InputEntry[] | null = null;
let chain: Promise<unknown> = Promise.resolve();
// A timestamp written before the claim commit cannot prove that its response was
// available. Restart discards this evidence and repeats the stable message id.
const offered = new Map<string, number>();
const terminal = (row: InputEntry): boolean => ['sent', 'cancelled', 'failed'].includes(row.state);
/** Native Send was never authorized: the row was not claimed, or its claim still awaited authorization. */
const neverAuthorized = (row: InputEntry): boolean => row.sendAuthorizedAt === undefined &&
  (row.offeredAt === undefined || row.requiresAuthorization === true);

export type DeliveryProof = 'sent' | 'not_sent' | 'unconfirmed' | 'pending';
/**
 * What the row itself proves about delivery, and nothing more. `sent` needs the receipt
 * (`deliveredAt`, which a late ACK can add to a row already cancelled). `not_sent` needs a
 * terminal row whose Send was never authorized. Any other terminal row, and any claim whose
 * Send was authorized or whose tool result was handed out, may have reached Gemini, so it is
 * `unconfirmed` and is never resent. Turn ids on the row (`completedTurnId`, `queuedTurn`,
 * `silenceBoundary`, `directTurn`) name the source turn, not the message, and prove nothing.
 */
export function deliveryProof(row: Readonly<InputEntry>): DeliveryProof {
  if (row.deliveredAt !== undefined) return 'sent';
  // `sent` says the page or the exact request confirmed it, so a row with that state and no
  // receipt is a gap in the record, not proof that nothing was sent.
  if (row.state === 'sent') return 'unconfirmed';
  if (terminal(row)) return neverAuthorized(row) ? 'not_sent' : 'unconfirmed';
  return row.state === 'queued' || (row.state === 'browser' && neverAuthorized(row)) ? 'pending' : 'unconfirmed';
}
const preparable = (row: InputEntry): boolean => row.state === 'queued' ||
  (row.state === 'browser' && row.requiresAuthorization === true && row.sendAuthorizedAt === undefined);
const needsHistory = (row: InputEntry): boolean => row.purpose !== 'decision' && !row.historyRecorded &&
  ((row.state === 'tool' && Number.isFinite(row.offeredAt)) || ((row.state === 'sent' || row.state === 'cancelled') && !!row.messageId));
const pendingStages = (row: InputEntry): boolean => row.state === 'sent' && !!row.stages?.length && !row.stagesApplied;
const ordered = (rows: InputEntry[]): InputEntry[] => [...rows].sort((a, b) =>
  (a.queueOrder ?? a.dueAt) - (b.queueOrder ?? b.dueAt) || a.createdAt - b.createdAt);
const companionOf = (rows: InputEntry[], row: InputEntry): InputEntry | undefined => rows.find(root => root.companionInputId === row.id);
const sameDelivery = (root: InputEntry, row: InputEntry): boolean => row.id === root.id || row.id === root.companionInputId;
function combinedInput(root: InputEntry, companion?: InputEntry): InputEntry {
  if (!companion) return root;
  const images = inputArgs.shape.images.parse([...root.images ?? [], ...companion.images ?? []]);
  const attachments = inputArgs.shape.attachments.parse([...root.attachments ?? [], ...companion.attachments ?? []]);
  return { ...root, text: `${root.text}\n\nNext queued instruction:\n${companion.text}`,
    ...(images?.length ? { images } : {}), ...(attachments?.length ? { attachments } : {}) };
}

function serial<T>(work: () => Promise<T>): Promise<T> {
  const result = chain.then(work, work);
  chain = result.catch(() => undefined);
  return result;
}

/**
 * Versions before opening reservations left ordinary New Chat rows without a sidebar owner.
 * Recover only that original authored opening: helpers, generated finish work, checkpoints and
 * either half of a combined delivery keep their existing owners. A confirmed delivery may only
 * join an exact current conversation owner below; it never creates retrospective history.
 *
 * Undelivered rows reserve their immutable outbox UUID. Existing offer/authorization/state and
 * frozen deliveryText travel unchanged, so a browser claim remains exclusive and cannot replay.
 * A provider ownership conflict therefore gets a visible unbound local chat, never a guessed
 * provider binding; a later exact receipt must still pass bindOpening's collision checks.
 */
async function migrateLegacyOpeningOwners(current: InputEntry[]): Promise<boolean> {
  let changed = false;
  for (let index = 0; index < current.length; index++) {
    const row = current[index]!;
    const combined = !!row.companionInputId || !!companionOf(current, row);
    const ordinaryOpening = !row.opening && row.sessionId === null && row.deliveredSessionId == null &&
      row.deliveredAt === undefined && !row.messageId && !row.historyAnchored && !row.historyRecorded &&
      manualInput(row) && ['queued', 'browser', 'failed', 'cancelled'].includes(row.state) && !combined;
    if (!ordinaryOpening) continue;

    if (row.conversationId) {
      const exact = await findSessionByConversation(row.conversationId, { requireUnique: true });
      const projectCompatible = exact && (!row.projectId || !exact.projectId || exact.projectId === row.projectId);
      const ordinaryOwner = projectCompatible && exact.origin?.kind !== 'worker' && exact.origin?.kind !== 'helper';
      if (exact && ordinaryOwner) {
        try {
          if (row.projectId && !exact.projectId) await assignSessionProject(exact.id, row.projectId);
          const migrated = { ...row, opening: true as const, requestedSessionId: null, sessionId: exact.id };
          await materializeOpening(migrated);
          current[index] = migrated;
          changed = true;
          continue;
        } catch {
          // Preserve the original row and recover it through an unbound reservation below.
        }
      }
    }

    const migrated = { ...row, opening: true as const, requestedSessionId: null, sessionId: row.id };
    try {
      // Materialize before publishing the migrated row. If publication is interrupted, the
      // unchanged legacy row deterministically reuses this same reserved session on next load.
      await materializeOpening(migrated);
    } catch {
      // A partial create can still have published the exact session. Keep it visible when that
      // identity exists; otherwise leave the legacy row untouched for a later safe retry.
      const partial = await getSession(row.id);
      if (!partial || partial.origin?.kind !== 'desktop' ||
          (partial.conversationId && partial.conversationId !== row.conversationId)) continue;
    }
    current[index] = migrated;
    changed = true;
  }
  return changed;
}

async function load(): Promise<InputEntry[]> {
  if (entries) return expireQueued(entries);
  const raw = await readDurable<unknown>(STATE);
  const parsed = z.array(entrySchema).safeParse(raw ?? []);
  if (!parsed.success) throw new Error('The message outbox could not be read safely');
  entries = parsed.data;
  const legacyOpeningRepair = await migrateLegacyOpeningOwners(entries);
  // One failed/deleted project must not prevent unrelated accepted work loading.
  let openingRepair = legacyOpeningRepair;
  for (const entry of entries) if (entry.opening && !terminal(entry)) {
    try {
      await materializeOpening(entry);
      if (entry.error?.startsWith('Local chat setup failed:')) { delete entry.error; openingRepair = true; }
    } catch (error) {
      entry.error = ('Local chat setup failed: ' + (error as Error).message).slice(0, 200);
      openingRepair = true;
    }
  }
  if (openingRepair) await commit(entries);
  for (const row of entries) await removeWithdrawnOpening(row, entries);
  try { await retireRemovedSessionReceipts(entries); }
  catch (error) { entries = null; throw error; }
  // Old receipts are recovery evidence, not a reason to replay every already-stamped
  // transcript before the sidebar appears. The existing catalog proves an origin is
  // durable; only missing/ambiguous rows need the normal origin repair path below.
  const stamped = new Set<string>();
  const seen = new Set<string>();
  if (entries.some(row => row.conversationId && (row.purpose === 'decision' || (!row.sessionId && row.deliveredAt !== undefined)))) {
    for (const summary of await listUsageSessions()) {
      if (!summary.conversationId) continue;
      if (seen.has(summary.conversationId)) stamped.delete(summary.conversationId);
      else if (summary.origin) stamped.add(summary.conversationId);
      seen.add(summary.conversationId);
    }
  }
  // Durable decision receipts recover helper provenance even when recording/ACK raced
  // or this version first opens a helper recorded before origins were stamped.
  for (const row of entries) {
    // Re-project wrapped receipts once when loading the outbox, so recordings made
    // before authoredText existed recover their original visible text too. This
    // is canonical history only; it never reopens transport or resends an input.
    if (row.historyRecorded && row.deliveryText && row.deliveryText !== row.text) row.historyRecorded = false;
    if (!row.sessionId && row.purpose !== 'decision' && row.conversationId && row.deliveredAt !== undefined && !stamped.has(row.conversationId)) {
      await noteChatOrigin(row.conversationId, { kind: 'desktop', fromSessionId: null, agentId: null, task: '' });
    }
    if (row.purpose === 'decision' && row.lifetime !== 'temporary-planner' && row.conversationId && !stamped.has(row.conversationId)) await deliveryHooks?.bindHelper?.(row.conversationId, row.decisionSourceSessionId ?? null);
  }
  const recovered = entries.map((row): InputEntry => row.purpose === 'decision' && !terminal(row) && !decisionWaiters.has(row.id)
    ? { ...row, state: 'cancelled' } : row);
  if (recovered.some((row, i) => row !== entries![i])) {
    try { await commit(recovered); }
    catch (error) { entries = null; throw error; }
  }
  return expireQueued(entries);
}
/** The outbox retains delivery proof until its exact history owner is removed.
 * Run under its existing serial queue, before origin repair or checkpoint publication.
 * Unconfirmed sends and missing/corrupt metadata never establish removal. */
async function retireRemovedSessionReceipts(current: InputEntry[], pendingOnly = false): Promise<InputEntry[]> {
  const missing = new Map<string, boolean>();
  const removed = new Set<string>();
  for (const row of current) {
    const sessionId = row.sessionId ?? row.deliveredSessionId;
    if (!sessionId || row.purpose === 'decision' || !['sent', 'cancelled'].includes(row.state) ||
        !row.messageId || !Number.isFinite(row.deliveredAt) ||
        (pendingOnly && !needsHistory(row) && !pendingStages(row))) continue;
    if (!missing.has(sessionId)) missing.set(sessionId, await sessionDirectoryMissing(sessionId));
    if (missing.get(sessionId)) removed.add(row.id);
  }
  // A combined delivery keeps both originals until both can be retired together.
  for (const row of current) {
    if (row.companionInputId && removed.has(row.id) !== removed.has(row.companionInputId)) {
      removed.delete(row.id); removed.delete(row.companionInputId);
    }
  }
  if (!removed.size) return current;
  const next = current.filter(row => !removed.has(row.id));
  await commit(next);
  return next;
}
async function expireQueued(current: InputEntry[]): Promise<InputEntry[]> {
  const next = await Promise.all(current.map(async (row): Promise<InputEntry> => {
    if (companionOf(current, row)) return row;
    if (row.recovery && row.state === 'browser' && row.sendAuthorizedAt !== undefined &&
        row.sessionId && row.conversationId && row.silenceBoundary?.conversationId === row.conversationId &&
        !row.companionInputId) {
      const session = await getSession(row.sessionId);
      // A committed handoff ends this generated Continue's wait in its old chat.
      // Keep the original claim and authorization for an exact late receipt; this
      // neither proves non-delivery nor authorizes a replay. Authored queue rows
      // still follow the session, and time alone never releases an uncertain send.
      if (session?.conversationId && session.conversationId !== row.conversationId &&
          session.chatIds.includes(row.conversationId)) return { ...row, state: 'cancelled' };
    }
    if (row.recovery && !terminal(row) && row.sendAuthorizedAt === undefined) {
      const reason = await recoveryInvalidReason(row);
      if (reason) return { ...row, state: 'cancelled', error: `Automatic Continue cancelled: ${reason}.` };
    }
    if (row.finishOwner && !terminal(row) && !(await finishInputCurrent(row)))
      return { ...row, state: 'cancelled', error: 'Automatic follow-up cancelled because its active turn or setting changed.' };
    if (row.purpose === 'decision') return row;
    if (row.state === 'queued' && row.delivery === 'tool' && row.toolTurnId) {
      const session = row.sessionId ? await getSession(row.sessionId) : null;
      const activity = session ? deliveryHooks?.activity?.(session) : null;
      const observedTurn = session?.activeTurnId ?? (!row.toolSteer && activity?.exact ? activity.turnId : null);
      const [boundary] = row.sessionId ? await readRecentEvents(row.sessionId, 1, { kinds: ['turn_start', 'turn_end'] }) : [];
      const targetEnded = !observedTurn && boundary?.kind === 'turn_end' && boundary.turnId === row.toolTurnId;
      const newerTurn = !!observedTurn && observedTurn !== row.toolTurnId;
      const newerBoundary = !observedTurn && !!boundary?.turnId && boundary.turnId !== row.toolTurnId;
      const ownerChanged = !session || session.conversationId !== row.conversationId;
      if (targetEnded || newerTurn || newerBoundary || ownerChanged) return { ...row, state: 'failed',
        error: 'Not injected: the selected turn ended before an eligible tool call.' };
    }
    if (row.state === 'tool') return settleToolInputFromFinal(row);
    // Only an ordinary browser attempt has an unclaimed startup deadline. Tool
    // intent survives a later terminal observation/restart; legacy bound-chat
    // rows are ambiguous and cannot safely be reclassified from today's activity.
    // A message the app itself holds ("Message queued. Finish Setup to send: …", or after a failed
    // browser start) was never offered to a browser. It stays queued with its reason and Retry;
    // failing it here lost it and blamed the browser instead.
    if (row.state === 'queued' && row.mode === 'auto' && !row.steerTurnId && !row.opening && !row.finishOwner && !row.silenceBoundary &&
        (row.transportIntent === 'browser' || (!row.transportIntent && !row.sessionId)) &&
        !row.preparationWait && !row.error?.startsWith('Message queued. ')) {
      // A message the live owner refuses to offer is still accepted user intent.
      // Local calls or an unresolved native boundary must not consume the browser's
      // pickup deadline. Resume the same row's ordinary deadline when it is eligible;
      // no claim or uncertain Send is replayed and authored time stays unchanged.
      if (manualInput(row) && row.sessionId && row.offeredAt === undefined) {
        if (!await browserInputAllowed(row)) return row.pickupHeldAt === undefined ? { ...row, pickupHeldAt: Date.now() } : row;
        if (row.pickupHeldAt !== undefined) return { ...row, pickupHeldAt: undefined, dueAt: Math.max(row.dueAt, Date.now()) };
      }
      if (Date.now() - Math.max(row.createdAt, row.dueAt) >= 60_000)
        return { ...row, state: 'failed', pickupFailedAt: Date.now(), error: 'Not sent: the browser did not pick up this message within 60 seconds.' };
    }
    // Preparation can expire before Send. Once authorized, this exact claim owns
    // the uncertain outcome until receipt or explicit cancellation, regardless of
    // how long Gemini takes to assign its durable conversation identity.
    const companion = current.find(other => other.id === row.companionInputId);
    const preparationMs = Math.max(row.opening ? FRESH_OPENING_PREPARATION_MS : 0,
      row.attachments?.length || companion?.attachments?.length ? 720_000 : row.images?.length || companion?.images?.length ? 120_000 : 60_000);
    if (row.state === 'browser' && row.sendAuthorizedAt === undefined && row.requiresAuthorization === true &&
        Date.now() >= Math.min((row.offeredAt ?? row.createdAt) + preparationMs, row.warmupRecovery?.expiresAt ?? Infinity)) {
      if (row.warmupRecovery && Date.now() >= row.warmupRecovery.expiresAt)
        return { ...row, state: 'cancelled', error: 'Not sent: browser preparation timed out. This attempt was cancelled.' };
      // Navigation was already authorized. Retain its original spent receipt
      // until the exact replacement is ready, regardless of history cooldown.
      if (row.nativeRecovery?.phase === 'refresh-dispatched') return row;
      // A never-authorized Continue still owes delivery. Retain its ticket and
      // pickup budget, but never replay a possibly consumed Stop after losing a page.
      if (row.recovery) return releaseRecoveryClaim(row);
      if (resumablePreparation(row)) return deferPreparation(row, 'provider-page');
      return { ...row, state: 'cancelled', error: row.requiresAuthorization && row.sendAuthorizedAt === undefined
        ? 'Not sent: browser preparation timed out. This attempt was cancelled.'
        : UNCONFIRMED_SEND };
    }
    // An authorized claim that never reports its outcome is already unsendable: a
    // browser row past authorization is not preparable, so no path re-offers or
    // replays it. Left in place it still owns its whole session, so every later
    // message waits behind an outcome nobody will ever publish. Retire it visibly
    // after a bounded wait. Automatic Continue, an opening's first send and a
    // combined delivery keep their existing custody.
    if (row.state === 'browser' && row.sendAuthorizedAt !== undefined && !row.recovery && !row.opening &&
        !row.companionInputId && manualInput(row) && Date.now() - row.sendAuthorizedAt >= UNCERTAIN_SEND_MS)
      return { ...row, state: 'cancelled', error: UNCONFIRMED_SEND };
    if (row.state === 'browser' && row.sendAuthorizedAt !== undefined && Date.now() - row.sendAuthorizedAt >= ABANDONED_SEND_MS)
      return { ...row, state: 'cancelled', error: UNCONFIRMED_SEND };
    return row;
  }));
  for (let i = 0; i < next.length; i++) {
    const root = companionOf(next, next[i]!);
    if (root && root.state !== next[i]!.state) next[i] = { ...next[i]!, state: root.state, error: root.error };
  }
  if (next.some((row, index) => row !== current[index])) {
    await commit(next);
    for (const [index, row] of next.entries()) if (row.recovery && row.state === 'cancelled' &&
      current[index]?.state !== 'cancelled')
      logInfo(`input ${row.id}: ${row.error ?? 'Automatic Continue wait retired after its session left the chat.'} conversation=${row.conversationId} turn=${row.silenceBoundary?.turnId}`);
  }
  return entries!;
}
/** Requeue the same durable row once when the browser never claimed it. */
export function retryUnclaimedInput(id: string): Promise<InputEntry | null> {
  return serial(async () => {
    const current = await load();
    const row = current.find(entry => entry.id === id);
    const now = Date.now();
    if (!row || row.state !== 'failed' || row.error !== 'Not sent: the browser did not pick up this message within 60 seconds.' ||
        !Number.isFinite(row.pickupFailedAt) || (row.pickupRetryCount !== undefined && row.pickupRetryCount !== 0) ||
        now - row.pickupFailedAt! < UNCLAIMED_PICKUP_RETRY_MIN_MS || now - row.pickupFailedAt! > UNCLAIMED_PICKUP_RETRY_MAX_AGE_MS ||
        now < row.createdAt || now - row.createdAt > UNCLAIMED_PICKUP_RETRY_MAX_AGE_MS || row.sendAuthorizedAt !== undefined || row.deliveredAt !== undefined ||
        row.mode !== 'auto' || row.transportIntent !== 'browser' || row.purpose === 'decision' || row.opening || row.requiresAuthorization ||
        row.cancelledByUser || row.recovery || row.silenceBoundary || row.finishOwner || row.directTurn || row.queuedTurn ||
        row.companionInputId || row.attachments?.length || row.images?.length || row.toolImages?.length || row.delivery ||
        row.attachmentDelivery || row.toolTurnId || row.automation || row.objective || row.stages?.length || row.loopAfterTurn ||
        !row.sessionId || !row.conversationId) return null;
    const session = await getSession(row.sessionId);
    const activity = session ? deliveryHooks?.activity?.(session) ?? { possible: !!session.activeTurnId, exact: !!session.activeTurnId } : null;
    if (!session || session.conversationId !== row.conversationId || activity?.possible || activity?.exact ||
        deliveryHooks?.recoveryAllowed?.(row.sessionId, row.conversationId) !== true ||
        session.browserRecoveryDismissedAt !== undefined || isChatBlocked(row.conversationId) ||
        await conversationWasSuperseded(row.conversationId) || inFlightToolCalls(row.conversationId) > 0) return null;
    const [boundary] = await readRecentEvents(row.sessionId, 1, { kinds: ['turn_start', 'turn_end'] });
    if (boundary?.kind !== 'turn_end' || boundary.time > row.createdAt || boundary.outcome === 'stopped') return null;
    const [newerMessage] = await readRecentEvents(row.sessionId, 1, { kinds: ['user_message'] });
    if (newerMessage && newerMessage.time > row.createdAt) return null;
    if (current.some(other => other.id !== row.id && other.sessionId === row.sessionId &&
        (!terminal(other) || other.createdAt > row.createdAt))) return null;
    const next: InputEntry = { ...row, state: 'queued', owner: null, dueAt: now, offeredAt: undefined,
      completedTurnId: undefined, error: undefined, pickupFailedAt: undefined, pickupRetryCount: 1 };
    await commit(current.map(entry => entry.id === row.id ? next : entry));
    logInfo(`input ${row.id}: requeued the same browser message after one proven pre-Send pickup timeout`);
    return next;
  });
}
async function commit(next: InputEntry[], beforeChanged?: () => void): Promise<void> {
  const previous = new Map((entries ?? []).map(row => [row.id, row]));
  next = next.map(row => ['failed', 'cancelled'].includes(row.state) && row.error && row.failedAt === undefined
    ? { ...row, failedAt: ['failed', 'cancelled'].includes(previous.get(row.id)?.state ?? '')
      ? row.createdAt : Date.now() } : row);
  // A temporary planner keeps only ownership metadata across restart, never its task or answer.
  const durableRows = (rows: InputEntry[]) => rows.map(row => row.lifetime === 'temporary-planner'
    ? { ...row, text: '[Temporary planner]', deliveryText: undefined, response: undefined } : row);
  try { await writeDurableNow(STATE, durableRows(next)); }
  catch (error) {
    // durable.ts retries failed generations. Never let a rejected send claim or
    // enqueue become live later behind the caller's back.
    writeDurableSoon(STATE, durableRows(entries ?? []));
    throw error;
  }
  entries = next;
  // A caller may derive secondary state from the exact durable input row. Publish that derived
  // state before observers receive the existing changed notification, so they cannot race the
  // durable commit and permanently cache an older projection. The durable write already won; a
  // secondary observer must never be allowed to roll it back.
  try { beforeChanged?.(); } catch { /* derived state cannot undo a durable input commit */ }
  wakeBrowserWork();
  for (const listener of inputListeners) { try { listener(); } catch { /* observer only */ } }
  try { deliveryHooks?.changed(); } catch { /* a detached renderer does not undo a durable commit */ }
}
/** Reserve the attempt durably before crossing into Goal's control ledger. The failed
 * row is the crash tombstone: an ambiguous settings write is never replayed after a
 * later user Off. Only this live operation may replace it with the successful delivery.
 */
async function transition(current: InputEntry[], next: InputEntry[], automated: InputEntry[], phase: 'before-send' | 'after-send', beforeChanged?: () => void): Promise<void> {
  if (automated.length) {
    if (!deliveryHooks) throw new Error('Input delivery is not ready');
    const reserved = new Map(automated.flatMap(entry => next.filter(row => sameDelivery(entry, row)).map(row => [row.id, row] as const)));
    await commit(current.map((entry): InputEntry => {
      const claimed = reserved.get(entry.id);
      return claimed ? { ...claimed, state: 'failed', error: phase === 'after-send'
        ? 'Message sent, but automation was not confirmed. Check its chat settings.'
        : 'Automation was not confirmed; this message was not sent. Send again to retry.' } : entry;
    }));
    for (const entry of automated) await deliveryHooks.applyAutomation(entry.conversationId!, entry.automation!, phase, entry.objective, entry.loopAfterTurn);
  }
  await commit(next, beforeChanged);
}
/** Freeze the exact transport bytes with its durable claim, never the authored enqueue payload. */
async function prepare(entry: InputEntry, suffix = '', nativeMedia = false): Promise<InputEntry> {
  if (entry.purpose === 'decision') return entry;
  // Generated openings and plans cannot replace the user's complete request.
  // Keep the authored text intact; freeze the complete objective in the same
  // delivery claim so retries cannot reconstruct a different opening message.
  const text = entry.stages !== undefined && entry.mode !== 'finish'
    ? `Original user request:\n${entry.objective || entry.text}\n\nComplete workflow:\n${[entry.text, ...entry.stages].map((stage, index) => `${index + 1}. ${stage}`).join('\n\n')}\n\nBegin the complete implementation now. Later queued messages are verification checkpoints; do not wait for them to learn or implement requirements. Carry out and verify each received checkpoint before asking for the next one with session_finish; never call it repeatedly just to collect the queue.`
    : entry.objective && (entry.opening || !entry.sessionId)
      ? `Original user request:\n${entry.objective}\n\nOpening instruction:\n${entry.text}\n\nFollow the complete original request, including all constraints, throughout this task.`
      : entry.text;
  const mandatoryOverhead = `${TOOL_INPUT_HEADER}\n\n${finishInstruction(getConfig().ui.finishLeadMinutes)}`;
  const proof = entry.state === 'browser' && entry.requiresAuthorization && entry.owner && entry.claimedBrowser && entry.offeredAt &&
    chatProviderForConversation(entry.conversationId, entry.chatProvider ?? getConfig().ui.chatProvider ?? DEFAULT_CHAT_PROVIDER) === 'chatgpt'
    ? { kind: 'input' as const, input: { id: entry.id, owner: entry.owner, browser: entry.claimedBrowser, offeredAt: entry.offeredAt } } : null;
  // A reloaded preparation can replace an UNSENT document owner. Reuse a durable
  // key only when its exact outbox claim remains current; authorized/ambiguous
  // sends cannot enter this preparation path at all.
  const frozen = entry.deliveryText && (!proof || hasCurrentChatgptBinding(entry.deliveryText, proof)) ? entry.deliveryText : undefined;
  const routing = !frozen && proof ? await chatgptBindingInstructions(proof) : '';
  const deliveryText = nativeMedia ? text + suffix : frozen ?? await deliveryHooks?.prepareText?.({ ...entry, text: text + suffix }, {
    maxChars: MAX_BROWSER_MESSAGE_CHARS, maxBytes: TOOL_INPUT_TEXT_BYTES - Buffer.byteLength(mandatoryOverhead)
  }, entry.authoredSource === 'none' ? '' : entry.authoredSource === 'objective' ? entry.objective ?? '' : entry.text, routing) ?? text + suffix + (routing ? '\n\n' + routing : '');
  // A single input must fit the tool envelope by itself. Aggregate batching below
  // may defer a second input, but cannot silently defer an individually impossible one.
  const envelope = `${TOOL_INPUT_HEADER}${deliveryText}\n\n${finishInstruction(getConfig().ui.finishLeadMinutes)}`;
  if (!deliveryText || deliveryText.length > MAX_BROWSER_MESSAGE_CHARS || Buffer.byteLength(envelope) > TOOL_INPUT_TEXT_BYTES)
    throw new Error('Prepared message exceeds the delivery limit; shorten the request or plan');
  return { ...entry, deliveryText };
}
function append(current: InputEntry[], entry: InputEntry, stackDirect = false): InputEntry[] {
  if (queuedFollowup(entry)) {
    const positioned = current.filter(row => row.sessionId === entry.sessionId && queuedFollowup(row) && !terminal(row) && row.queueOrder !== undefined);
    if (positioned.length) entry = { ...entry, queueOrder: Math.max(...positioned.map(row => row.queueOrder!)) + 1 };
  }
  // Admission is per durable session. Native composer custody stays with each claim.
  if (!stackDirect && entry.purpose !== 'decision' && !queuedFollowup(entry) && current.some(row => row.sessionId === entry.sessionId && row.purpose !== 'decision' &&
      !(!entry.finishOwner && row.finishOwner && row.state === 'tool') &&
      (!queuedFollowup(row) || row.state === 'browser') && ['queued', 'browser', 'tool'].includes(row.state))) {
    throw new Error('One message is already awaiting delivery. Cancel it before sending another.');
  }
  const active = current.filter((row) => !terminal(row) || needsHistory(row) || pendingStages(row));
  const reserved = (row: InputEntry) => row.stagesApplied ? [] : row.stages ?? [];
  if ([...active, entry].reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify({ ...row, images: undefined, toolImages: undefined, stages: reserved(row) })), 0) > 1024000) {
    throw new Error('The message queue is full');
  }
  const imageBytes = (row: InputEntry): number => [...row.images ?? [], ...row.toolImages ?? []].reduce((sum, image) => sum + image.dataUrl.length, 0) +
    (row.attachments ?? []).reduce((sum, file) => sum + (file.preview?.length ?? 0), 0);
  if ([...active, entry].reduce((sum, row) => sum + imageBytes(row), 0) > 4 * 1024 * 1024) throw new Error('The image queue is full');
  const history = current.filter((row) => terminal(row) && !needsHistory(row) && !pendingStages(row)).slice(-50);
  const bytes = (row: InputEntry): number => Buffer.byteLength(row.text) + Buffer.byteLength(row.deliveryText ?? '') + Buffer.byteLength(row.response ?? '') + Buffer.byteLength(JSON.stringify(row.stages ?? [])) + imageBytes(row);
  let retainedBytes = [...history, ...active, entry].reduce((sum, row) => sum + bytes(row), 0);
  while (history.length && retainedBytes > 2048000) retainedBytes -= bytes(history.shift()!);
  // A frozen delivery needs both originals for restart/history until both can be
  // discarded together. Never retain a dangling companion id after trimming.
  const retained = new Set([...history, ...active, entry].map(row => row.id));
  return [...history.filter(row => {
    const root = companionOf(current, row);
    return (!row.companionInputId || retained.has(row.companionInputId)) && (!root || retained.has(root.id));
  }), ...active, ...current.filter(row => !retained.has(row.id) && active.some(root => sameDelivery(root, row) || root.id === row.companionInputId)), entry];
}
/**
 * The historical ChatGPT-only text/composer contract. Gemini is admitted through
 * its validated companion protocol rather than a name-based Pro/non-Pro guess.
 *
 * On a model that is not Pro, text inside a tool result never reached the model (#1231). Measured
 * 2026-10-12 on GPT-6 Thinking: while the page kept closing a turn whose request kept calling tools,
 * four messages in a row were folded into tool results, never appeared in the conversation and were
 * not acted on as the user's words. Pro turns, images and attachments keep the tool path.
 */
function composerOnlyText(entry: Pick<InputEntry, 'images' | 'attachments' | 'attachmentDelivery' | 'toolImages'> & Parameters<typeof manualInput>[0],
  session: Pick<SessionSummary, 'conversationId' | 'selectedModel'> | null | undefined): boolean {
  if (geminiInput(session?.conversationId)) return false;
  const selection = session?.selectedModel;
  return manualInput(entry) && !entry.images?.length && !entry.attachments?.length && !entry.toolImages?.length &&
    !!session?.conversationId && selection?.conversationId === session.conversationId && !!selection.model &&
    !isProModel(selection.model, selection.reasoningEffort);
}
async function target(entry: InputEntry): Promise<string | null> {
  if (entry.purpose === 'decision') {
    if (entry.conversationId && isChatBlocked(entry.conversationId)) throw new Error('Unblock this helper conversation before sending');
    return entry.conversationId;
  }
  if (!entry.sessionId) return null;
  const session = await getSession(entry.sessionId);
  if (entry.opening && session?.origin?.kind === 'desktop' && !session.conversationId) return null;
  if (!session?.conversationId) throw new Error('This recording has no provider conversation');
  if (isChatBlocked(session.conversationId)) throw new Error('Unblock this conversation before sending');
  return session.conversationId;
}
async function finishInputCurrent(entry: InputEntry): Promise<boolean> {
  // Periodic generation was retired; persisted rows cannot regain delivery authority.
  if (!entry.finishOwner || entry.finishOwner.periodic || !entry.sessionId) return false;
  const session = await getSession(entry.sessionId), config = getConfig();
  return !!session?.conversationId && session.conversationId === entry.conversationId &&
    session.activeTurnId === entry.finishOwner.turnId && session.finishTurn?.turnId === entry.finishOwner.turnId &&
    !session.finishTurn.released && config.ui.finishTool === true && !isChatBlocked(session.conversationId) &&
    session.origin?.kind !== 'worker' && session.origin?.kind !== 'helper' &&
    // Earlier finish decisions always used Loop. A mode change cannot deliver
    // either a legacy Loop instruction or a newly drafted decision for the old mode.
    (entry.finishOwner.mode ?? 'loop') === goalDrivingMode(session.conversationId) &&
    (entry.finishOwner.userRequested === true || automaticFinishEnabled(session.conversationId));
}
/** The accepted outbox identity repairs a partially materialized session after restart. */
async function materializeOpening(entry: InputEntry): Promise<void> {
  if (!entry.opening || !entry.sessionId) return;
  const existing = await getSession(entry.sessionId);
  const recoveredExactOwner = !!existing && entry.requestedSessionId === null && !!entry.conversationId &&
    existing.conversationId === entry.conversationId &&
    existing.origin?.kind !== 'worker' && existing.origin?.kind !== 'helper';
  const session = recoveredExactOwner ? existing : await createSession({ reservedId: entry.sessionId,
    title: userTitle(entry.text, entry.text), titleSource: 'fallback',
    origin: { kind: 'desktop', fromSessionId: null, agentId: null, task: '' } });
  if (session.conversationId && session.conversationId !== entry.conversationId)
    throw new Error('Reserved opening session belongs to another provider conversation');
  if (entry.projectId && session.projectId !== entry.projectId) await assignSessionProject(session.id, entry.projectId);
}
/**
 * Files the app's automatic continue into a long running turn (#1402).
 *
 * Turns past about 35 minutes almost always broke (stream lost, delivery timeout); Stop and
 * "continue" by hand never did. A native send into the running turn is exactly that: Gemini ends
 * the turn as interrupted and continues in a fresh one, and a command in flight keeps its result
 * (measured 2026-10-09). The row is the ordinary direct message for that turn, marked `rotation`:
 * it is no one's typed message, so a page that cannot take it drops it rather than keeping it for
 * after the turn, and a message of the user's own replaces it before it is handed out. Filed only
 * for that exact running turn, never beside another pending message, never for Pro or a blocked chat.
 */
export function fileRotationInput(sessionId: string, turnId: string): Promise<InputEntry | null> {
  return serial(async () => {
    const current = await load();
    if (current.some(row => row.sessionId === sessionId && !terminal(row))) return null;
    const session = await getSession(sessionId);
    if (!session?.conversationId || session.activeTurnId !== turnId || isChatBlocked(session.conversationId)) return null;
    const policy = await sessionInputPolicy(sessionId);
    if (policy.directTurn?.id !== turnId) return null;
    const now = Date.now();
    const entry: InputEntry = { id: randomUUID(), sessionId, text: rotationMessage(), mode: 'auto', dueAt: now, model: null, reasoningEffort: null,
      authoredSource: 'none', purpose: 'rotation', directTurn: policy.directTurn, transportIntent: 'browser',
      queuedTurn: { conversationId: session.conversationId, turnId }, state: 'queued', owner: null, createdAt: now,
      conversationId: session.conversationId };
    await commit(append(current, entry));
    return { ...entry };
  });
}

export function enqueueInput(raw: InputArgs, finishOwner?: InputEntry['finishOwner'], scheduleId?: string): Promise<InputEntry> {
  const selectedProvider = raw.provider ?? getConfig().ui.chatProvider ?? DEFAULT_CHAT_PROVIDER;
  return serial(async () => {
    const input = inputArgs.parse(raw);
    const requestedMode = input.mode;
    if (scheduleId !== undefined && (!z.string().uuid().safeParse(scheduleId).success || !input.sessionId ||
        input.mode !== 'after-turn' || finishOwner || input.delivery || input.attachmentDelivery || input.steerTurnId ||
        input.images?.length || input.attachments?.length || input.stages?.length || input.automation || input.objective))
      throw new Error('Scheduled input requires an existing chat and a native after-turn message');
    if (input.stages !== undefined && JSON.stringify([input.text, ...input.stages]).length > 12000)
      throw new Error('Keep the complete plan below 12,000 characters');
    const current = await load();
    const prior = current.find((entry) => entry.id === input.id);
    if (prior) {
      if (prior.scheduleId !== scheduleId) throw new Error('Message id already belongs to different scheduling authority');
      if (JSON.stringify(inputArgs.parse({ ...prior, sessionId: prior.opening ? prior.requestedSessionId ?? null : prior.sessionId, mode: prior.requestedMode ?? prior.mode })) !== JSON.stringify(input)) throw new Error('Message id already belongs to different input');
      if (!terminal(prior)) await materializeOpening(prior);
      return { ...prior };
    }
    const requestedSession = input.sessionId ? await getSession(input.sessionId) : null;
    if (scheduleId && (!requestedSession?.conversationId || requestedSession.origin?.kind === 'worker'))
      throw new Error('Scheduled input requires a bound normal chat');
    if (input.provider && requestedSession?.conversationId && chatProviderForConversation(requestedSession.conversationId) !== input.provider)
      throw new Error('An existing chat keeps its provider');
    if (input.steerTurnId && (!requestedSession?.conversationId || input.mode !== 'auto' ||
        input.delivery || input.attachmentDelivery || input.stages?.length || finishOwner))
      throw new Error('Steer requires the current running turn in a normal chat');
    const requestedSteerTurnId = input.steerTurnId;
    let steerSource = input.steerTurnId && input.sessionId && requestedSession?.conversationId
      ? await steeringSource(input.sessionId, requestedSession.conversationId, input.steerTurnId) : null;
    if (input.steerTurnId && !steerSource) {
      // The renderer can race the recorder by one native turn boundary. Losing the authored
      // follow-up here forced the user to type it again and was especially common after a long
      // Steer/Compact cycle. A stale Steer target is not permission to inject into the successor,
      // but it is still valid authored intent for this same chat: keep it as an ordinary message.
      // If another turn is already running, queue behind that exact current turn; if the old turn
      // merely ended, ordinary auto delivery will use the now-idle native composer.
      delete input.steerTurnId;
      delete input.delivery;
      if (requestedSession?.activeTurnId) input.mode = 'after-turn';
      logInfo('input ' + input.id + ': selected Steer turn ' + requestedSteerTurnId + ' changed before admission; preserving the message as ' + (input.mode === 'after-turn' ? 'an after-turn follow-up' : 'an ordinary send'));
    }
    // Explicit injection has its own recipient and can never spend a browser completion.
    const activity = requestedSession && input.delivery !== 'tool' && input.attachmentDelivery !== 'tool'
      ? deliveryHooks?.activity?.(requestedSession) : null;
    const sourceTurn = requestedSession?.activeTurnId ?? (activity?.exact ? activity.turnId : null);
    const queuedTurn = requestedSession?.conversationId && sourceTurn
      ? { conversationId: requestedSession.conversationId, turnId: sourceTurn } : undefined;
    const authoredAt = authoredBrowserInput({ ...input, scheduleId, finishOwner }) ? Date.now() : undefined;
    let policy = input.sessionId ? await sessionInputPolicy(input.sessionId, undefined, authoredAt) : null;
    const previousOpening = [...current].reverse().find(row => row.opening && row.sessionId === input.sessionId);
    if (input.provider && previousOpening?.chatProvider && !requestedSession?.conversationId && previousOpening.chatProvider !== input.provider)
      throw new Error('An opening chat keeps its provider');
    // An explicit reviewed resend may replace a proven pre-send failure in the same
    // local chat. An ambiguous native Send still owns its receipt; never replay it.
    const retryOpening = !!(input.sessionId && requestedSession?.origin?.kind === 'desktop' && !requestedSession.conversationId &&
      previousOpening && terminal(previousOpening) && neverAuthorized(previousOpening));
    let toolImages: InputImage[] | undefined;
    let injectionOwner: { conversationId: string; turnId: string } | undefined;
    // Inject now reaches the model only as a real message (see sessionInputPolicy): when the running
    // turn takes one, the explicit choice goes through the composer too. Files keep the tool path.
    if (input.delivery === 'tool' && !input.attachmentDelivery && !input.attachments?.length && !input.images?.length &&
        input.mode === 'auto' && !finishOwner && !input.stages?.length && policy?.directTurn) delete input.delivery;
    // Not a Pro turn and no direct turn to join: the text waits for the composer instead.
    if (!finishOwner && !input.stages?.length && composerOnlyText({ ...input, mode: input.mode }, requestedSession)) {
      if (input.delivery === 'tool') delete input.delivery;
      if (policy?.canInject) policy = { ...policy, canInject: false };
    }
    const toolDelivery = input.delivery === 'tool' || input.attachmentDelivery === 'tool';
    if (toolDelivery) {
      const turnId = policy?.directTurn?.id ?? policy?.injectionTurnId;
      if (!input.sessionId || input.mode !== 'auto' || finishOwner || input.stages?.length || !turnId ||
          (input.images?.length ?? 0) + (input.attachments?.length ?? 0) > MAX_INPUT_IMAGES)
        throw new Error(`Inject up to ${MAX_INPUT_IMAGES} images into an active chat; otherwise use Send or After this turn`);
      const owner = await getSession(input.sessionId);
      if (!owner?.conversationId) throw new Error('Inject into an active chat');
      injectionOwner = { conversationId: owner.conversationId, turnId };
      if (input.attachments?.length) toolImages = await normalizeInputAttachments(input.attachments);
    } else if (input.attachments?.length) {
      await validateInputAttachments(input.attachments);
      // Native files belong to the next browser message, never a tool-result injection.
      if (finishOwner) throw new Error('Automatic finish messages cannot attach files');
      if (input.mode === 'finish' || (!input.steerTurnId && input.mode === 'auto' && (policy?.canInject || policy?.directTurn))) input.mode = 'after-turn';
    } else if (!scheduleId && input.mode === 'after-turn' && policy?.queueAtFinish) input.mode = 'finish';
    if (input.mode === 'finish' || input.stages?.length) {
      const session = input.sessionId ? await getSession(input.sessionId) : null;
      if ((input.mode === 'finish' && !session?.conversationId) || session?.origin?.kind === 'worker') throw new Error('Queue staged tasks in a normal chat');
    }
    // Unattributed work can fence browser Send without making this chat a tool recipient.
    // Leave that input neutral until the existing serialized claim selects a safe transport.
    const transportIntent = scheduleId || input.steerTurnId ? 'browser' as const : toolDelivery ? 'tool' as const : input.attachments?.length ? 'browser' as const : input.mode === 'auto' && !finishOwner
      ? policy?.canInject ? 'tool' as const : !policy || policy.browserAllowed || policy.directTurn ? 'browser' as const : undefined : undefined;
    const directTurn = steerSource ?? (!input.steerTurnId && !toolDelivery && input.mode === 'auto' && !finishOwner && input.dueAt <= Date.now() ? policy?.directTurn : null);
    const entry: InputEntry = { ...input, ...(scheduleId ? { scheduleId } : {}), chatProvider: chatProviderForConversation(requestedSession?.conversationId, previousOpening?.chatProvider ?? selectedProvider), ...(queuedTurn ? { queuedTurn } : {}), ...(toolImages ? { toolImages } : {}), ...(directTurn ? { directTurn } : {}),
      ...(steerSource ? { steerReady: true as const } : {}),
      ...(injectionOwner ? { toolTurnId: injectionOwner.turnId } : {}), ...(transportIntent ? { transportIntent } : {}),
      ...(requestedMode !== input.mode ? { requestedMode } : {}), ...(finishOwner ? { finishOwner } : {}), state: 'queued', owner: null, createdAt: Date.now(), conversationId: null };
    if (input.projectId) {
      await projectWorkspace(input.projectId);
      if (input.sessionId) {
        const session = await getSession(input.sessionId);
        if (session?.projectId !== input.projectId) throw new Error('Message project does not match the session');
        await getSessionProject(input.sessionId);
      }
    }
    const authoredOrdinary = (input.authoredSource ?? 'text') === 'text' && input.mode !== 'finish' &&
      !finishOwner && !input.stages?.length;
    if (getConfig().ui.autoSelectSkills === true && authoredOrdinary && invokedSkills(input.text).length === 0) {
      const folder = input.sessionId ? await getSessionProject(input.sessionId)
        : input.projectId ? await projectWorkspace(input.projectId) : null;
      entry.autoSkills = await autoSelectManagedSkills(input.text, { projectPath: folder?.real ?? null });
    }
    if (retryOpening) { entry.opening = true; entry.requestedSessionId = input.sessionId; }
    entry.conversationId = await target(entry);
    if (!input.sessionId) {
      entry.opening = true;
      entry.sessionId = input.id;
    }
    if (finishOwner && !(await finishInputCurrent(entry))) throw new Error('The automatic follow-up no longer belongs to an active turn');
    if (injectionOwner) {
      policy = await sessionInputPolicy(input.sessionId!);
      const owner = await getSession(input.sessionId!);
      const turnId = policy.directTurn?.id ?? policy.injectionTurnId;
      if (turnId !== injectionOwner.turnId || owner?.conversationId !== injectionOwner.conversationId || entry.conversationId !== injectionOwner.conversationId)
        throw new Error(input.delivery === 'tool'
          ? 'The active chat changed while preparing injection; send again'
          : 'The active chat changed while preparing images; send again');
    }
    // User input supersedes only automatic work that has never been handed out.
    // Offered tool receipts retain their identity until a later request proves receipt.
    const prioritized = !finishOwner ? current.map(row => row.sessionId === entry.sessionId &&
      ((row.finishOwner && row.state === 'queued') || (row.recovery && !terminal(row) && row.sendAuthorizedAt === undefined) ||
        (row.purpose === 'rotation' && !terminal(row) && row.sendAuthorizedAt === undefined))
      ? { ...row, state: 'cancelled' as const, error: 'Replaced by your new instruction before delivery.' } : row) : current;
    let next = append(prioritized, entry, input.mode === 'auto' && !finishOwner && policy?.canInject === true);
    // A finish plan belongs to an existing session now. Publish every editable
    // checkpoint atomically; no composer text or first-send receipt owns its life.
    if (entry.mode === 'finish') next = materializeStages(next, entry);
    await commit(next);
    try { await materializeOpening(entry); }
    catch (error) {
      const failed = { ...entry, error: ('Local chat setup failed: ' + (error as Error).message).slice(0, 200) };
      await commit(next.map(row => row.id === entry.id ? failed : row));
      throw error;
    }
    return { ...next.find(row => row.id === entry.id)! };
  });
}
function materializeStages(current: InputEntry[], entry: InputEntry): InputEntry[] {
  const sessionId = entry.sessionId ?? entry.deliveredSessionId;
  if (!sessionId || entry.stages === undefined || entry.stagesApplied) return current;
  let next = current.map(row => row.id === entry.id ? { ...row, stagesApplied: true } : row);
  // Checkpoints inherit the current chat model, including later user selections.
  for (const [index, text] of entry.stages.entries()) next = append(next, {
    id: randomUUID(), sessionId, projectId: entry.projectId, text, authoredSource: 'none', mode: 'finish', dueAt: entry.createdAt + index,
    model: null, reasoningEffort: null, state: 'queued', owner: null, createdAt: entry.createdAt + index, conversationId: entry.conversationId,
    ...(entry.queuedTurn ? { queuedTurn: entry.queuedTurn } : {})
  });
  return next;
}
export function listInputs(): Promise<InputEntry[]> {
  return serial(async () => {
    const current = await retireRemovedSessionReceipts(await load(), true);
    let next: InputEntry[] = [];
    for (const entry of current) {
      if (entry.purpose !== 'decision' && (entry.state === 'sent' || (entry.state === 'cancelled' && entry.deliveredAt !== undefined)) && !entry.sessionId && entry.conversationId && !entry.deliveredSessionId) {
        const session = await findSessionByConversation(entry.conversationId, { requireUnique: true });
        next.push(session ? { ...entry, deliveredSessionId: session.id } : entry);
      } else next.push(entry);
    }
    for (const entry of [...next]) {
      if (entry.state === 'sent') next = materializeStages(next, entry);
    }
    if (next.length !== current.length || next.some((entry, index) => entry !== current[index])) await commit(next);
    await publishHistory();
    return ordered(await load()).map((entry) => ({ ...entry }));
  });
}
export interface PickupRecoveryState { attempts: number; nextAt?: number; stoppedAt?: number }

async function rowsForPickupSource(current: InputEntry[], sessionId: string, sourceTurnId: string): Promise<InputEntry[]> {
  const matching: InputEntry[] = [];
  for (const entry of current) {
    if (entry.sessionId !== sessionId || entry.purpose === 'decision' || entry.opening) continue;
    if (await eligibleStageEnd(entry) === sourceTurnId) matching.push(entry);
  }
  return matching;
}

function mergedPickupState(rows: InputEntry[], inherited?: PickupRecoveryState): PickupRecoveryState {
  const attempts = Math.min(BROWSER_PICKUP_MAX_ATTEMPTS,
    Math.max(inherited?.attempts ?? 0, ...rows.map(row => row.pickupRecovery?.attempts ?? 0)));
  const stoppedAt = inherited?.stoppedAt ?? rows.find(row => row.pickupRecovery?.stoppedAt)?.pickupRecovery?.stoppedAt;
  if (stoppedAt || attempts >= BROWSER_PICKUP_MAX_ATTEMPTS) return {
    attempts, stoppedAt: stoppedAt ?? rows.find(row => row.pickupRecovery?.stoppedAt)?.pickupRecovery?.stoppedAt ?? Date.now()
  };
  const nextAt = inherited?.attempts === attempts ? inherited.nextAt : undefined;
  return { attempts, ...(nextAt ?? rows.find(row => row.pickupRecovery?.attempts === attempts)?.pickupRecovery?.nextAt
    ? { nextAt: nextAt ?? rows.find(row => row.pickupRecovery?.attempts === attempts)?.pickupRecovery?.nextAt } : {}) };
}

/** Copies a source-turn budget to every durable input owner, so reorder/replacement cannot reset it. */
export function syncQueuedPickupRecoveryNow(inputId: string, sourceTurnId: string, state: PickupRecoveryState): Promise<PickupRecoveryState | null> {
  return serial(async () => {
    const current = await load();
    const row = current.find(entry => entry.id === inputId && entry.state === 'queued');
    if (!row?.sessionId || row.purpose === 'decision' || await eligibleStageEnd(row) !== sourceTurnId) return null;
    const matches = await rowsForPickupSource(current, row.sessionId, sourceTurnId);
    const merged = mergedPickupState(matches, state);
    const next = current.map(entry => matches.includes(entry) && !samePickupState(entry.pickupRecovery, merged)
      ? { ...entry, pickupRecovery: merged } : entry);
    if (next.some((entry, index) => entry !== current[index])) await commit(next);
    return merged;
  });
}

function samePickupState(a: PickupRecoveryState | undefined, b: PickupRecoveryState): boolean {
  return a?.attempts === b.attempts && a?.nextAt === b.nextAt && a?.stoppedAt === b.stoppedAt;
}

/** Reserve a source-turn reload against all of its queued owners before browser handout. */
export function recordQueuedPickupAttemptNow(inputId: string, sourceTurnId: string, at: number, nextAt?: number, inherited?: PickupRecoveryState): Promise<PickupRecoveryState | null> {
  return serial(async () => {
    const current = await load();
    const row = current.find(entry => entry.id === inputId);
    if (!row || !row.sessionId || row.purpose === 'decision' || row.state !== 'queued' ||
        await eligibleStageEnd(row) !== sourceTurnId) return null;
    const session = await getSession(row.sessionId);
    if (!session || session.conversationId !== row.conversationId || session.browserRecoveryDismissedAt !== undefined) return null;
    const matches = await rowsForPickupSource(current, row.sessionId, sourceTurnId);
    const prior = mergedPickupState(matches, inherited);
    if (prior.stoppedAt || prior.attempts >= BROWSER_PICKUP_MAX_ATTEMPTS) {
      const next = current.map(entry => matches.includes(entry) && !samePickupState(entry.pickupRecovery, prior)
        ? { ...entry, pickupRecovery: prior } : entry);
      if (next.some((entry, index) => entry !== current[index])) await commit(next);
      return null;
    }
    const attempts = prior.attempts + 1;
    const pickupRecovery = attempts >= BROWSER_PICKUP_MAX_ATTEMPTS ? { attempts, stoppedAt: at }
      : { attempts, ...(nextAt !== undefined ? { nextAt } : {}) };
    const next = current.map(entry => matches.includes(entry) ? { ...entry, pickupRecovery } : entry);
    await commit(next);
    return { attempts, ...('nextAt' in pickupRecovery && pickupRecovery.nextAt ? { nextAt: pickupRecovery.nextAt } : {}),
      ...('stoppedAt' in pickupRecovery && pickupRecovery.stoppedAt ? { stoppedAt: pickupRecovery.stoppedAt } : {}) };
  });
}
/** A sent receipt survives a recorder failure. Existing outbox reads retry publication,
 * never transport; the stable canonical key makes a lost recording ACK idempotent. */
async function publishHistory(): Promise<void> {
  const current = await load();
  const recorded = new Set<string>();
  const anchored = new Map<string, number>();
  for (const row of current) {
    if (!needsHistory(row) || companionOf(current, row)) continue;
    const anchorCommitted = (seq: number) => {
      anchored.set(row.id, seq);
      if (row.companionInputId) anchored.set(row.companionInputId, seq);
    };
    try { if (deliveryHooks?.recordDelivered && await deliveryHooks.recordDelivered(combinedInput(row, current.find(other => other.id === row.companionInputId)), anchorCommitted)) {
      recorded.add(row.id);
      if (row.companionInputId) recorded.add(row.companionInputId);
    } }
    catch { /* delivered, retained, and still visible until canonical recording succeeds */ }
  }
  if (recorded.size || current.some(row => anchored.has(row.id) && (!row.historyAnchored || row.historySeq !== anchored.get(row.id)))) {
    try { await commit(current.map(row => recorded.has(row.id) || anchored.has(row.id)
      ? { ...row, ...(recorded.has(row.id) ? { historyRecorded: true } : {}), ...(anchored.has(row.id) ? { historyAnchored: true, historySeq: anchored.get(row.id) } : {}) } : row)); }
    catch { /* the durable delivery receipt remains; canonical retry is idempotent */ }
  }
}
export function cancelInput(id: string): Promise<boolean> {
  return serial(async () => {
    const current = await load();
    const selected = current.find((entry) => entry.id === id);
    const found = selected && (companionOf(current, selected) ?? selected);
    if (!found || !['queued', 'browser', 'failed', 'cancelled'].includes(found.state)) return false;
    if (['failed', 'cancelled'].includes(found.state)) {
      // Dismissing a terminal notice is not Stop or withdrawal of an uncertain
      // Send. Preserve its lifecycle, revocation flags and late-ACK custody.
      await commit(current.map(entry => sameDelivery(found, entry) ? { ...entry, noticeDismissedAt: Date.now() } : entry));
      return true;
    }
    await commit(current.map((entry) => sameDelivery(found, entry) ? { ...entry, state: 'cancelled', cancelledByUser: true,
      error: found.state === 'browser' ? found.requiresAuthorization && found.sendAuthorizedAt === undefined
        ? 'Not sent: this delivery was cancelled before Send was authorized.'
        : 'Cancelled locally. Delivery to the provider is unconfirmed; the message may already have been sent.'
        : found.state === 'queued' ? undefined : entry.error } : entry));
    decisionWaiters.get(id)?.reject(new Error('goal_browser_cancelled'));
    decisionWaiters.delete(id);
    await removeWithdrawnOpening(entries!.find(row => row.id === found.id)!, entries!);
    return true;
  });
}

/** Only explicit withdrawal of a provably unsent opening retires its empty reservation.
 * The cancelled outbox row remains the tombstone; timeout/failure never grants deletion.
 * Runs under the input queue, which also owns initial provider binding and Send authority. */
async function removeWithdrawnOpening(row: InputEntry, current: InputEntry[]): Promise<void> {
  if (!row.opening || !row.sessionId || row.state !== 'cancelled' ||
      !(row.cancelledByUser || row.error === 'Not sent: this delivery was cancelled before Send was authorized.') ||
      !neverAuthorized(row) || row.deliveredAt !== undefined || row.messageId || row.conversationId ||
      current.some(other => other.id !== row.id && other.sessionId === row.sessionId && !terminal(other))) return;
  const session = await getSession(row.sessionId);
  if (!session || session.origin?.kind !== 'desktop' || session.conversationId || session.chatIds?.length !== 0 || session.events !== 0) return;
  await deleteSession(session.id);
  try { deliveryHooks?.changed(); } catch { /* deletion is already committed */ }
}

/** The last tool in a turn may be followed by a final rather than another MCP call.
 * Join that final to the recorded exact request, preserving restart proof and rejecting
 * interim prose, old finals, foreign turns and calls still publishing their response. */
async function settleToolInputFromFinal(row: InputEntry): Promise<InputEntry> {
  if (!row.sessionId || !row.conversationId || (!row.owner && !row.toolGeminiOffer) || row.offeredAt === undefined ||
      inFlightToolCalls(row.conversationId) > 0) return row;
  const session = await getSession(row.sessionId);
  if (session?.conversationId !== row.conversationId || session.lastAssistantFinalAt == null) return row;
  if (row.toolGeminiOffer) {
    // Receipt settlement grants no new execution. The original exact turn may
    // already have ended, but rotation/revocation/rebinding still withdraw custody.
    if (!row.toolGeminiOffer.inputTurn || row.toolGeminiOffer.inputTurn.turnId !== row.toolTurnId) return row;
    try { await validateLocalBindingReceipt({ bindingId: row.toolGeminiOffer.bindingId, inputTurn: row.toolGeminiOffer.inputTurn,
      conversationId: row.conversationId, sessionId: row.sessionId, attribution: row.toolGeminiOffer.attribution ?? 'gemini_session_capability' }); }
    catch { return row; }
  }
  const calls = await readRecentEvents(row.sessionId, 256, { kinds: ['tool_call'] });
  const call = calls.find(event => event.kind === 'tool_call' && event.source === 'mcp' && event.turnId &&
    (!row.toolTurnId || event.turnId === row.toolTurnId) &&
    (row.toolGeminiOffer
      ? event.call.attributionMethod === (row.toolGeminiOffer.attribution ?? 'gemini_session_capability') && event.time === row.toolGeminiOffer.startedAt &&
        !event.call.nested && event.turnId === row.toolTurnId
      : event.call.attribution === 'request_id' && event.call.requestId === row.owner) &&
    event.call.conversationId === row.conversationId && event.time <= row.offeredAt!);
  if (!call?.turnId) return row;
  const final = await readCompletedFinal(row.sessionId, row.conversationId, call.turnId);
  if (!final || final.completedAt <= row.offeredAt || final.contentSeq <= call.seq ||
      inFlightToolCalls(row.conversationId) > 0) return row;
  return { ...row, state: 'sent', toolTurnId: call.turnId, messageId: `input:${row.id}`, deliveredAt: final.completedAt, historyRecorded: false };
}

/** Editing is possible only before handout. Recovery shares delivery custody,
 * but its frozen message and source never belong to the authored task order. */
export function reorderQueuedInputs(sessionId: string, ids: string[]): Promise<boolean> {
  return serial(async () => {
    const current = await load();
    const queue = current.filter(row => row.sessionId === sessionId && queuedFollowup(row) && !row.recovery && row.state === 'queued');
    // A stale snapshot must not move claimed input or omit newly queued work.
    if (!ids.length || ids.length !== queue.length || new Set(ids).size !== ids.length ||
        queue.some(row => !ids.includes(row.id))) return false;
    const positions = new Map(ids.map((id, index) => [id, index]));
    const ticket = queue.find(row => row.silenceBoundary)?.silenceBoundary;
    await commit(current.map(row => positions.has(row.id) ? { ...row, queueOrder: positions.get(row.id)!,
      ...(ticket ? { silenceBoundary: row.id === ids[0] ? ticket : undefined } : {}) } : row));
    return true;
  });
}

/** Called inside the existing serialized settings transaction after publishing Off
 * and before re-enabling On (also recovering a failed earlier retirement).
 * A later On cannot revive these durable cancellations, even across restart. */
export function cancelFinishInputs(periodicOnly: boolean): Promise<void> {
  return serial(async () => {
    const current = await load();
    const next = current.map(row => row.finishOwner && (!periodicOnly || row.finishOwner.periodic) && !terminal(row)
      ? { ...row, state: 'cancelled' as const, error: 'Automatic follow-up cancelled by settings. Already offered input may have reached the provider.' } : row);
    if (next.some((row, index) => row !== current[index])) await commit(next);
  });
}

export function editQueuedInput(id: string, text: string, afterTurn?: boolean): Promise<boolean> {
  return serial(async () => {
    const value = inputArgs.shape.text.parse(text);
    const current = await load();
    const row = current.find(entry => entry.id === id && entry.state === 'queued' && queuedFollowup(entry) && !entry.recovery);
    if (!row) return false;
    if (current.filter(entry => !terminal(entry)).reduce((sum, entry) => sum + Buffer.byteLength(entry === row ? value : entry.text), 0) > 1024000) throw new Error('Queued messages exceed the text limit');
    await commit(current.map(entry => entry === row ? { ...row, text: value, authoredSource: 'text',
      ...(afterTurn === undefined ? {} : { afterTurn }), deliveryText: undefined, autoSkills: undefined } : entry));
    return true;
  });
}

/**
 * Convert an unclaimed follow-up into a real browser message. Explicit live Steer
 * uses the provider's native busy composer without stopping the task or waiting for a tool.
 */
export function sendQueuedInputNow(id: string, intent?: QueuedInputNowIntent): Promise<boolean> {
  return serial(async () => {
    const current = await load();
    const row = current.find(entry => entry.id === id && entry.state === 'queued' && entry.mode === 'after-turn' && queuedFollowup(entry) &&
      !entry.recovery && !entry.finishOwner && !entry.attachments?.length && !entry.images?.length && !entry.stages?.length &&
      entry.owner === null && entry.offeredAt === undefined && entry.sendAuthorizedAt === undefined && !!entry.sessionId);
    if (!row) return false;
    const policy = await sessionInputPolicy(row.sessionId!);
    const session = await getSession(row.sessionId!);
    if (!session?.conversationId || session.conversationId !== row.conversationId || isChatBlocked(session.conversationId)) return false;
    const turnId = session.activeTurnId;
    const idle = !session.activeTurnId && policy.browserAllowed && policy.settled;
    if (!turnId && !idle) return false;
    if (turnId && (row.queuedTurn?.turnId !== turnId || row.queuedTurn.conversationId !== session.conversationId)) return false;
    if (intent && (intent.delivery === 'idle' ? !idle || intent.turnId !== null : !turnId || intent.turnId !== turnId)) return false;
    const source = turnId ? await steeringSource(row.sessionId!, session.conversationId, turnId) : null;
    if (turnId && !source) return false;
    // The person chose immediate delivery for this message; it is no longer an after-turn request.
    const { requestedMode: _requested, silenceBoundary: _silence, directTurn: _direct, delivery: _delivery, toolSteer: _toolSteer, toolTurnId: _toolTurn, ...rest } = row;
    await commit(current.map(entry => entry === row ? { ...rest, mode: 'auto' as const,
      ...(turnId ? { steerTurnId: turnId, steerReady: true as const, directTurn: source! } : {}), transportIntent: 'browser' as const,
      dueAt: Math.min(row.dueAt, Date.now()) } : entry));
    return true;
  });
}

/** An unclaimed legacy Steer may acquire exact live composer custody. Previously
 * spent refresh receipts retain their original terminal boundary and cannot replay. */
export function releaseSteeringInput(id: string): Promise<boolean> {
  return serial(async () => {
    const current = await load();
    const row = current.find(entry => entry.id === id && entry.state === 'queued' && entry.owner === null && entry.steerTurnId && entry.sessionId);
    if (!row) throw new Error('Steering input is no longer queued');
    if (!row.nativeRecovery && !row.steerClosedOnce && row.conversationId) {
      const source = await steeringSource(row.sessionId!, row.conversationId, row.steerTurnId!);
      if (source) {
        if (!row.steerReady || row.directTurn?.id !== source.id || row.directTurn.questionId !== source.questionId) {
          await commit(current.map(entry => entry === row ? { ...entry, steerReady: true as const,
            directTurn: source, error: undefined } : entry));
          wakeBrowserWork();
        }
        return true;
      }
    }
    const session = await getSession(row.sessionId!);
    const [end] = await readRecentEvents(row.sessionId!, 1, { kinds: ['turn_start', 'turn_end'] });
    if (session?.conversationId !== row.conversationId) return false;
    if (session.activeTurnId && session.activeTurnId !== row.steerTurnId) {
      // The exact Steer recipient changed after admission. Never retarget an injection silently;
      // retain the authored message and queue it behind the successor turn instead.
      const { steerTurnId: _steer, steerReady: _ready, directTurn: _direct, nativeRecovery: _recovery,
        steerClosedOnce: _closed, ...rest } = row;
      const queued: InputEntry = { ...rest, mode: 'after-turn', requestedMode: row.requestedMode ?? row.mode,
        queuedTurn: { conversationId: row.conversationId!, turnId: session.activeTurnId },
        error: undefined, transportIntent: undefined };
      await commit(current.map(entry => entry === row ? queued : entry));
      wakeBrowserWork();
      logInfo('input ' + row.id + ': Steer target changed to ' + session.activeTurnId + '; preserved the message after the current turn');
      return true;
    }
    if (session.activeTurnId || end?.kind !== 'turn_end' ||
      !['completed', 'stopped', 'failed', 'interrupted'].includes(end.outcome) || end.turnId !== row.steerTurnId) return false;
    const question = await readLatestUserMessage(row.sessionId!, row.steerTurnId!);
    // Old records with no exact native question remain held instead of borrowing
    // whichever response happens to be mounted in the browser now.
    if (!question?.messageId) return false;
    const questionId = question.messageId;
    await commit(current.map(entry => entry === row ? { ...entry, steerReady: true as const,
      nativeRecovery: { turnId: row.steerTurnId!, questionId, phase: 'ready-to-refresh' as const } } : entry));
    wakeBrowserWork();
    return true;
  });
}
/** A guarded hung-page refresh spends once while retaining the original steering intent.
 * The durable steerClosedOnce name is retained for existing receipts. */
export function permitSteeringClose(id: string, sessionId: string, turnId: string): Promise<boolean> {
  return serial(async () => {
    const current = await load();
    const row = current.find(entry => entry.id === id && entry.sessionId === sessionId && entry.state === 'queued' &&
      entry.steerTurnId === turnId && !entry.steerReady && !entry.steerClosedOnce && entry.sendAuthorizedAt === undefined && !entry.cancelledByUser);
    if (!row || !row.conversationId || runningToolProgress(row.conversationId) ||
        (await getSession(sessionId))?.activeTurnId !== turnId || runningToolProgress(row.conversationId)) return false;
    await commit(current.map(entry => entry === row ? { ...entry, steerClosedOnce: true as const,
      error: 'Waiting for the exact chat to refresh and confirm its native Stop.' } : entry));
    return true;
  });
}

/** The same original opening owns a spent pre-task refresh across normal app/browser restart. */
export function permitGeminiWarmupRefresh(id: string, owner: string, browser: string, source: WarmupDocument,
  questionId: string | null, deadline?: number): Promise<ReturnType<typeof warmupRecoveryView> | null> {
  return serial(async () => {
    const current = await load(), row = current.find(entry => entry.id === id);
    if (!row?.opening || row.chatProvider !== 'gemini' || !row.sessionId || row.state !== 'browser' ||
        row.owner !== owner || row.claimedBrowser !== browser || !row.requiresAuthorization || row.conversationId !== null ||
        row.sendAuthorizedAt !== undefined || row.deliveredAt !== undefined || row.warmupRecovery ||
        !owner.startsWith(`${source.tab_id}:${source.document_id}:`) ||
        !/^\d+$/.test(owner.slice(`${source.tab_id}:${source.document_id}:`.length))) return null;
    const session = await getSession(row.sessionId);
    if (!session || session.conversationId || session.origin?.kind !== 'desktop') return null;
    const budget = Math.max(FRESH_OPENING_PREPARATION_MS,
      row.attachments?.length ? 720_000 : row.images?.length ? 120_000 : 60_000);
    const expiresAt = Math.min((row.offeredAt ?? row.createdAt) + budget, deadline ?? Infinity);
    if (Date.now() >= expiresAt) return null;
    const recovery: WarmupRecovery = { spent: true, questionId, at: Date.now(), expiresAt,
      browser, tab: source.tab_id, document: source.document_id, owner };
    await commit(current.map(entry => entry === row ? { ...entry, warmupRecovery: recovery } : entry));
    return warmupRecoveryView(recovery);
  });
}

/** The refreshed blank home may initialize once; this never authorizes the original task. */
export function permitGeminiWarmupInitialization(id: string, owner: string, browser: string,
  source: WarmupDocument): Promise<ReturnType<typeof warmupRecoveryView> | null> {
  return serial(async () => {
    const current = await load(), row = current.find(entry => entry.id === id);
    if (!row?.warmupRecovery || !row.opening || row.chatProvider !== 'gemini' || !row.sessionId ||
        row.state !== 'browser' || row.owner !== owner || row.claimedBrowser !== browser ||
        !row.requiresAuthorization || row.conversationId !== null || row.cancelledByUser ||
        row.sendAuthorizedAt !== undefined || row.deliveredAt !== undefined) return null;
    const recovery = reserveWarmupInitialization(row.warmupRecovery, owner, browser, source);
    if (!recovery) return null;
    const session = await getSession(row.sessionId);
    if (!session || session.conversationId || session.origin?.kind !== 'desktop') return null;
    await commit(current.map(entry => entry === row ? { ...entry, warmupRecovery: recovery } : entry));
    // A recorder metadata transition can race the durable outbox write. Keep the
    // reservation spent, but do not return permission for a now-bound session.
    const after = await getSession(row.sessionId);
    return after && !after.conversationId && Date.now() < recovery.expiresAt ? warmupRecoveryView(recovery) : null;
  });
}

/** Revalidate the same durable claim immediately before sending; never hand out text again. */
export function authorizeBrowserInput(id: string, owner: string, conversationId: string | null): Promise<boolean> {
  return serial(async () => {
    const current = await load();
    const row = current.find(row => row.id === id && row.owner === owner && row.state === 'browser' && row.conversationId === conversationId);
    if (!row || row.sendAuthorizedAt !== undefined || companionOf(current, row) ||
        (row.warmupRecovery && (!row.conversationId || row.owner !== row.warmupRecovery.successorOwner)) ||
        (row.recovery && row.nativeRecovery?.phase !== 'ready') ||
        (row.nativeRecovery && row.nativeRecovery.phase !== 'ready')) return false;
    if (!(await browserInputAllowed(row)) || await target(row) !== conversationId) return false;
    if (row.companionInputId) {
      const companion = current.find(other => other.id === row.companionInputId && other.state === 'browser' && other.owner === owner && other.sessionId === row.sessionId);
      const session = row.sessionId ? await getSession(row.sessionId) : null;
      if (!companion || !session || !queuedAfterTurn({ ...companion, state: 'queued' }, session)) return false;
    }
    await commit(current.map(entry => sameDelivery(row, entry) ? { ...entry, sendAuthorizedAt: Date.now() } : entry));
    // Recorder work is serialized independently and can arrive during the durable
    // claim write. Keep the spent claim, but never publish stale Send permission.
    if (row.recovery && !await recoveryCurrent(row)) return false;
    if (row.steerTurnId && row.directTurn?.questionId && !await browserInputAllowed(row)) return false;
    // Recovery still has a native final veto after this await. Its browser claim
    // holds Goal until either the exact send receipt or a known pre-click abort.
    if (!row.recovery && row.completedTurnId && row.sessionId && conversationId)
      await consumeGoalReplyForInputNow(conversationId, row.sessionId, row.completedTurnId);
    return !row.recovery || await recoveryCurrent(row);
  });
}
/** The same outbox serialization owns mode changes and browser ACK. A late ACK
 * must observe Off; an ACK that won first is followed by the exact bound-chat Off. */
export function setInputAutomation(id: string, automation: NonNullable<InputArgs['automation']>, loopAfterTurn?: boolean): Promise<boolean> {
  return serial(async () => {
    const mode = z.enum(['off', 'goal', 'loop']).parse(automation);
    const delivery = z.boolean().optional().parse(loopAfterTurn);
    const current = await load();
    const entry = current.find(row => row.id === id && row.purpose !== 'decision' && ['queued', 'browser', 'sent', 'tool'].includes(row.state));
    if (!entry) return false;
    const conversationId = entry.conversationId;
    if (conversationId && await conversationWasSuperseded(conversationId)) return false;
    const sessionId = entry.sessionId ?? entry.deliveredSessionId;
    if (sessionId && (await getSession(sessionId))?.conversationId !== conversationId) return false;
    await commit(current.map(row => row === entry ? { ...row, automation: mode,
      ...(delivery === undefined ? {} : { loopAfterTurn: delivery }) } : row));
    if (conversationId && (mode === 'off' || entry.state !== 'queued')) {
      if (!deliveryHooks) throw new Error('Input delivery is not ready');
      // Mode changes preserve the chat's current objective. Only the delivery
      // transition transfers the opening text; an old outbox row must not overwrite
      // an objective the user edited after this message was delivered.
      await deliveryHooks.applyAutomation(conversationId, mode, entry.state === 'sent' ? 'after-send' : 'before-send', undefined, delivery);
    }
    return true;
  });
}
export function noteInputStartupError(id: string, error: string | null): Promise<InputEntry | null> {
  return serial(async () => {
    const current = await load();
    const row = current.find(entry => entry.id === id);
    if (!row) return null;
    if (row.state !== 'queued') return { ...row };
    // Retry session materialization through its accepted identity before releasing
    // browser delivery. A failed project write must not be hidden by a wake result.
    try { await materializeOpening(row); }
    catch (failure) { error = 'Local chat setup failed: ' + (failure as Error).message; }
    // Releasing the app's own hold makes the message due now: the browser's 60-second pickup
    // window starts here, not when the message was first sent and held.
    const released = !error && !!row.error?.startsWith('Message queued. ');
    const next = { ...row, error: error ? error.slice(0, 200) : undefined, ...(released ? { dueAt: Math.max(row.dueAt, Date.now()) } : {}) };
    await commit(current.map(entry => entry === row ? next : entry));
    return { ...next };
  });
}
/** A paired browser may explain an unclaimed route; it cannot claim or Send it. */
export function noteBrowserInputRouting(id: string, provider: ChatProvider, issue: string | null): Promise<boolean> {
  return serial(async () => {
    if (provider !== 'gemini') return false;
    const messages: Record<string, string> = {
      gemini_account_context_required: 'Open Gemini in this browser and select the account to use.',
      gemini_selected_account_changed: 'Wait for the Gemini account switch to finish.',
      gemini_conversation_account_unknown: 'Open this existing Gemini chat in its original account.',
      gemini_conversation_account_ambiguous: 'Select the original Gemini account for this chat.'
    };
    if (issue !== null && !messages[issue]) return false;
    const current = await load(), row = current.find(entry => entry.id === id);
    if (!row || row.state !== 'queued' || row.owner || row.offeredAt !== undefined || row.sendAuthorizedAt !== undefined ||
        chatProviderForConversation(await target(row), row.chatProvider ?? getConfig().ui.chatProvider ?? DEFAULT_CHAT_PROVIDER) !== provider) return false;
    const prefix = 'Message queued. Browser routing: ';
    if (row.error && !row.error.startsWith(prefix)) return false;
    const error = issue === null ? undefined : prefix + messages[issue];
    if (row.error === error) return true;
    await commit(current.map(entry => entry === row ? { ...entry, error, ...(!error ? { dueAt: Math.max(row.dueAt, Date.now()) } : {}) } : entry));
    return true;
  });
}
/** The same exact source boundary must still apply at claim and final Send authorization. */
async function eligibleStageEnd(entry: InputEntry): Promise<string | null> {
  if (!entry.sessionId) return null;
  if (entry.recovery) return await recoveryCurrent(entry) &&
    ['ready', 'resumed'].includes(entry.recovery.phase) && (entry.silenceBoundary?.listenUntil ?? 0) <= Date.now()
    ? entry.silenceBoundary!.turnId : null;
  const session = await getSession(entry.sessionId);
  if (!session || session.origin?.kind === 'worker') return null;
  const [end] = await readRecentEvents(entry.sessionId, 1, { kinds: ['turn_start', 'turn_end'] });
  // A later native final cannot erase an actual busy rejection. Keep this
  // existing delay for the exact source turn until its native retry is due.
  if (entry.silenceBoundary?.nativeBusy && (entry.silenceBoundary.listenUntil ?? 0) > Date.now()) return null;
  // Explicit corrections bypass only the failed-view wait. Ordinary silence still
  // needs its confirmed refresh, and fresh work/in-flight custody always veto Send.
  if (manualInput(entry) && !session.activeTurnId && end?.kind === 'turn_end' && end.turnId &&
      end.outcome === 'failed' && end.reason === 'thinking_failed' &&
      (session.lastToolCallAt ?? 0) <= end.time && session.conversationId &&
      !isChatBlocked(session.conversationId) && inFlightToolCalls(session.conversationId) === 0) return end.turnId;
  if (entry.silenceBoundary) {
    const boundary = entry.silenceBoundary;
    if (session.conversationId !== boundary.conversationId || isChatBlocked(boundary.conversationId) ||
        (session.activeTurnId && session.activeTurnId !== boundary.turnId) || inFlightToolCalls(boundary.conversationId) > 0) return null;
    if (end?.turnId !== boundary.turnId) return null;
    if (!(end.kind === 'turn_end' && end.outcome === 'completed') &&
        !await turnHasMcpCall(entry.sessionId, boundary.conversationId, boundary.turnId)) return null;
    if (end.kind !== 'turn_end' || end.outcome !== 'completed') {
      if ((boundary.listenUntil ?? 0) > Date.now() ||
          (end.kind === 'turn_end' && (session.lastToolCallAt ?? 0) > end.time)) return null;
      const [work] = await readRecentEvents(entry.sessionId, 1, { kinds: INPUT_WORK_KINDS });
      return work && workSequence(work) === boundary.workSeq ? boundary.turnId : null;
    }
    // A real final supersedes the silence assumption and spends the same source turn.
  }
  if (session.activeTurnId) return null;
  // A failure releases manual input immediately. Automatic follow-ups require
  // the confirmed refresh ticket above; only a real completion bypasses it.
  if (end?.kind !== 'turn_end' || end.outcome !== 'completed' || !end.turnId) return null;
  // Queue intent names the turn we were waiting for, not when Chrome reported it.
  // Other turns and legacy rows retain the later-completion rule. A rebind cannot
  // lend this reference to another frontend, even if its turn id happens to match.
  const queuedHere = entry.queuedTurn?.conversationId === session.conversationId && entry.queuedTurn?.turnId === end.turnId;
  if (!queuedHere && end.time < entry.createdAt) return null;
  const authored = authoredBrowserInput(entry);
  const policy = await sessionInputPolicy(entry.sessionId, undefined, authored ? entry.createdAt : undefined);
  if (!(authored ? policy.browserAllowed : policy.settled)) return null;
  return end.turnId;
}
const INPUT_WORK_KINDS: import('../../shared/session.js').SessionEvent['kind'][] =
  ['user_message', 'assistant_message', 'tool_call', 'page_tool', 'turn_start', 'turn_end'];

function queuedAfterTurn(row: InputEntry, session: SessionSummary): boolean {
  const astra = session.selectedModel?.conversationId === session.conversationId &&
    isAstraModel(session.selectedModel.model, session.selectedModel.reasoningEffort);
  return row.sessionId === session.id && (queuedFollowup(row) || (manualInput(row) && row.offeredAt === undefined)) && row.state === 'queued' && row.dueAt <= Date.now() &&
    (row.mode !== 'finish' || row.afterTurn === true || !astra);
}
export async function hasQueuedAfterTurnInput(sessionId: string): Promise<boolean> {
  const session = await getSession(sessionId);
  return !!session && (await load()).some(row => queuedAfterTurn(row, session));
}

/** Read the same visible head as claims, including its still-running listening window.
 * Historical restored tickets without an acceptance timestamp never arm browser recovery. */
export function pendingQueuedPickups(): Promise<Array<{ inputId: string; conversationId: string; sessionId: string; sourceTurnId: string; acceptedAt: number; listenUntil: number; pro: boolean; pickupAttempts: number; pickupNextAt?: number; pickupStoppedAt?: number }>> {
  return serial(async () => {
    const rows = await load();
    const result: Array<{ inputId: string; conversationId: string; sessionId: string; sourceTurnId: string; acceptedAt: number; listenUntil: number; pro: boolean; pickupAttempts: number; pickupNextAt?: number; pickupStoppedAt?: number }> = [];
    const pending = ordered(rows).filter(row => row.sessionId && row.purpose !== 'decision' && ['queued', 'browser', 'tool'].includes(row.state));
    for (const sessionId of new Set(pending.map(row => row.sessionId))) {
      const candidates = pending.filter(row => row.sessionId === sessionId);
      const row = candidates.find(row => manualInput(row) && row.silenceBoundary) ?? candidates[0]!;
      if (!row.sessionId) continue;
      if (row.state !== 'queued' || (!queuedFollowup(row) && !manualInput(row)) || row.dueAt > Date.now()) continue;
      const session = await getSession(row.sessionId);
      if (!session?.conversationId || !queuedAfterTurn(row, session)) continue;
      const probe = row.silenceBoundary ? { ...row, silenceBoundary: { ...row.silenceBoundary, listenUntil: undefined } } : row;
      const sourceTurnId = await eligibleStageEnd(probe);
      if (!sourceTurnId || rows.some(other => other.sessionId === row.sessionId &&
          (consumedTurn(other, sourceTurnId) || other.state === 'browser' || other.state === 'tool'))) continue;
      const [end] = await readRecentEvents(row.sessionId, 1, { kinds: ['turn_start', 'turn_end'] });
      const completed = end?.kind === 'turn_end' && end.outcome === 'completed';
      const acceptedAt = row.silenceBoundary?.acceptedAt ?? (!row.silenceBoundary && completed ? end.time : undefined);
      if (acceptedAt === undefined) continue;
      const selection = session.selectedModel;
      const sourceOwners = await rowsForPickupSource(rows, row.sessionId, sourceTurnId);
      const pickupRecovery = mergedPickupState(sourceOwners);
      result.push({ inputId: row.id, conversationId: session.conversationId, sessionId: row.sessionId, sourceTurnId, acceptedAt,
        listenUntil: completed && !row.silenceBoundary?.nativeBusy ? 0 : row.silenceBoundary?.listenUntil ?? 0,
        pro: selection?.conversationId === session.conversationId && isProModel(selection.model, selection.reasoningEffort),
        pickupAttempts: pickupRecovery.attempts,
        ...(pickupRecovery.nextAt ? { pickupNextAt: pickupRecovery.nextAt } : {}),
        ...(pickupRecovery.stoppedAt ? { pickupStoppedAt: pickupRecovery.stoppedAt } : {}) });
    }
    return result;
  });
}

function consumedTurn(row: InputEntry, turnId: string): boolean {
  return row.completedTurnId === turnId &&
    (row.sendAuthorizedAt !== undefined || row.deliveredAt !== undefined || row.requiresAuthorization === false);
}

/** The visible outbox precedes automatic Goal work, including an ineligible head.
 * A spent completion also belongs to its user input after that row leaves the queue. */
export function inputBeforeGoal(sessionId: string, sourceTurnId?: string): Promise<'queued' | 'consumed' | null> {
  return serial(async () => {
    const rows = await load();
    if (rows.some(row => row.sessionId === sessionId && row.purpose !== 'decision' &&
      ['queued', 'browser', 'tool'].includes(row.state))) return 'queued';
    return sourceTurnId && rows.some(row => row.sessionId === sessionId && consumedTurn(row, sourceTurnId)) ? 'consumed' : null;
  });
}

/** A native-only queue head needs the held answer to finish before it can send. */
export function finishNeedsBrowserInput(sessionId: string): Promise<boolean> {
  return serial(async () => {
    const head = ordered(await load()).find(row => row.sessionId === sessionId && row.purpose !== 'decision' &&
      ['queued', 'browser', 'tool'].includes(row.state));
    if (!head || head.state !== 'queued' || head.dueAt > Date.now() ||
      !(head.mode === 'after-turn' || (head.attachments?.length && head.attachmentDelivery !== 'tool'))) return false;
    const session = await getSession(sessionId);
    return !!session && queuedAfterTurn(head, session);
  });
}

// Control-only turn_end observations (including our own Stop) are not renewed work.
const RECOVERY_WORK_KINDS: import('../../shared/session.js').SessionEvent['kind'][] =
  ['user_message', 'assistant_message', 'tool_call', 'page_tool', 'turn_start'];
/**
 * Hands a recovery ticket back to the queue, keeping the reason it came back.
 *
 * The ticket surviving is the point — a Continue that was never authorized is still owed, and its
 * pickup budget is deliberately retained. What was lost with it was the explanation: the page tells
 * the app exactly why it could not send, `failBrowserInput` carried that string, and this dropped it
 * on the floor while every other branch there keeps it. So a row could be claimed and released over
 * and over with nothing written down anywhere.
 *
 * Measured on 2026-09-26: one recovery row claimed twelve times in three minutes, back to `queued`
 * each time, no `error` on the receipt and not one line in the log. The loop was only visible at all
 * because the claims themselves are logged.
 */
function releaseRecoveryClaim(row: InputEntry, error?: string): InputEntry {
  return { ...row, state: 'queued', owner: null, offeredAt: undefined, completedTurnId: undefined,
    ...(error ? { error: error.slice(0, 200) } : {}),
    recovery: { ...row.recovery!, phase: row.recovery!.phase === 'stopping' ? 'stopping' :
      row.recovery!.phase === 'ready' ? 'ready' : row.nativeRecovery ? row.recovery!.phase : 'resumed' } };
}
function resumablePreparation(row: InputEntry): boolean {
  return row.purpose !== 'decision' && !row.lifetime && !row.recovery && !row.finishOwner;
}
function deferPreparation(row: InputEntry, reason: NonNullable<InputEntry['preparationWait']>['reason']): InputEntry {
  return { ...row, state: 'queued', owner: null, offeredAt: undefined, requiresAuthorization: undefined,
    completedTurnId: undefined, dueAt: Math.max(row.dueAt, Date.now() + 5_000),
    preparationWait: { reason, since: row.preparationWait?.since ?? Date.now(), attempts: (row.preparationWait?.attempts ?? 0) + 1 },
    error: reason === 'answer-resumed' ? 'Waiting because the answer resumed.' : reason === 'editor-unavailable'
      ? 'Waiting for the provider editor.' : reason === 'document-rebind' ? 'Waiting for the provider document to reconnect.' : 'Waiting for provider page.' };
}
async function recoveryCurrent(row: InputEntry): Promise<boolean> {
  const conversationId = row.silenceBoundary?.conversationId;
  // Unassigned calls conservatively block every chat while attribution settles, for a bounded
  // time once the chat was found silent (#1086). They cannot prove that this frozen source
  // resumed. Hold the ticket, rechecking around asynchronous validation; actual recorded work
  // still retires it below.
  const held = (id: string) => deliveryHooks?.callsHoldRecovery ? deliveryHooks.callsHoldRecovery(id) : inFlightToolCalls(id) > 0;
  return !!conversationId && !held(conversationId) &&
    await recoveryInvalidReason(row) === null && !held(conversationId);
}
/** Keep the rejection on the existing outbox receipt so an audit can identify the veto. */
async function recoveryInvalidReason(row: InputEntry): Promise<string | null> {
  const boundary = row.silenceBoundary;
  if (!row.recovery || !row.sessionId || !boundary) return 'the recovery source is missing';
  if (isChatBlocked(boundary.conversationId)) return 'this chat is blocked';
  const unavailable = () => deliveryHooks?.recoveryAllowed?.(row.sessionId!, boundary.conversationId) !== true
    ? 'automatic continuation is off or paused' : null;
  const session = await getSession(row.sessionId);
  if (!session || session.conversationId !== boundary.conversationId) return 'the session moved to another chat';
  if (session.browserRecoveryDismissedAt !== undefined) return 'the browser chat was closed';
  if (session.origin?.kind === 'worker' || session.origin?.kind === 'helper') return 'this task has a separate recovery owner';
  if (session.activeTurnId && session.activeTurnId !== boundary.turnId) return 'another turn started';
  if (session.finishTurn?.released) return 'the turn was released';
  const [end] = await readRecentEvents(row.sessionId, 1, { kinds: ['turn_start', 'turn_end'] });
  if (end?.turnId !== boundary.turnId) return 'the recorded turn changed';
  if (end.kind === 'turn_end' && end.outcome === 'stopped') return 'the user stopped the turn';
  if (!await questionHasMcpCall(row.sessionId, boundary.conversationId, boundary.turnId)) return 'the source has no confirmed local tool call';
  if (await readCompletedFinal(row.sessionId, boundary.conversationId)) return 'the complete answer arrived';
  const question = await readLatestUserMessage(row.sessionId, boundary.turnId);
  const [work] = await readRecentEvents(row.sessionId, 1, { kinds: RECOVERY_WORK_KINDS });
  if (question?.messageId !== row.recovery.questionId) return 'another user message arrived';
  if (!work || workSequence(work) !== boundary.workSeq) return 'the source received new work';
  const changed = unavailable();
  if (changed) return changed;
  return (await getSession(row.sessionId))?.conversationId === boundary.conversationId ? null : 'the session moved to another chat';
}

const recoveryRefusalsTold = new Set<string>();

/** Shared unfinished-response ticket; mode policy belongs to the bridge hook. */
export function fileRecoveryInput(sessionId: string, conversationId: string, turnId: string, pro: boolean,
  currentOwner: () => boolean, busyUntil = Date.now() + recoveryBusyMs(pro), episode = `turn:${turnId}`): Promise<boolean> {
  // Every refusal says why, once per turn and reason. Silent refusals cost a stopped chat its
  // only automatic restart with nothing anywhere naming the cause (2026-09-26: a prime's restart
  // was refused twice and the log said only that the chat had stopped).
  const refused = (why: string): false => {
    const key = `${conversationId}:${turnId}:${why}`;
    if (!recoveryRefusalsTold.has(key)) {
      recoveryRefusalsTold.add(key);
      if (recoveryRefusalsTold.size > 500) recoveryRefusalsTold.delete(recoveryRefusalsTold.values().next().value!);
      logInfo(`input: automatic Continue for ${conversationId} not filed — ${why} (turn ${turnId})`);
    }
    return false;
  };
  return serial(async () => {
    const current = await load();
    // Never overtake authored input, retry an ambiguous send, or reuse a spent source.
    if (current.some(row => row.sessionId === sessionId && !terminal(row))) return refused('an earlier message of this session is still awaiting delivery');
    const question = await readLatestUserMessage(sessionId, turnId);
    const [work] = await readRecentEvents(sessionId, 1, { kinds: RECOVERY_WORK_KINDS });
    if (!question?.messageId) return refused('the session has no recorded question to continue');
    if (!work) return refused('the session has no recorded work to continue');
    if (!currentOwner()) return false;
    // One live ticket per turn, and never a replay of an authorized send — but a ticket that ended
    // without ever reaching Send answered nothing and must not stand in for one. Watched live on
    // 2026-09-23: a rescue was filed at 20:32:35 when the chat stopped, and cancelled fifteen
    // seconds later as "the source received new work" — correct, the chat had resumed by itself.
    // Two minutes after that the same turn broke again: its error reload was spent, three silence
    // reloads came back with the same failure, the watch gave up, and this check refused the
    // second rescue on the strength of the cancelled first. The chat sat until its owner typed.
    // `sendAuthorizedAt` keeps its own veto: an authorized send is ambiguous forever and is never
    // retried, whatever state its row reached.
    if (current.some(row => row.sessionId === sessionId && row.recovery && row.silenceBoundary?.turnId === turnId &&
        (row.sendAuthorizedAt !== undefined ||
          (!terminal(row) && (!row.recovery.episode || row.recovery.episode === episode))))) return refused('this turn already has its restart');
    // A Continue a page already refused for this exact work is not filed again unchanged.
    if (current.some(row => row.sessionId === sessionId && row.recovery?.ended && row.silenceBoundary?.turnId === turnId &&
        row.silenceBoundary.workSeq === workSequence(work))) return refused('pages refused this restart and nothing has changed since');
    const now = Date.now();
    const row: InputEntry = { id: randomUUID(), sessionId, conversationId, owner: null, state: 'queued',
      mode: 'after-turn', dueAt: now, createdAt: now, model: null, reasoningEffort: null,
      text: recoveryMessage({ playful: getConfig().ui.playfulContinue === true }),
      recovery: { questionId: question.messageId, episode, pro, busyUntil, phase: 'ready' },
      silenceBoundary: { turnId, conversationId, workSeq: workSequence(work), acceptedAt: now } };
    if (!await recoveryCurrent(row)) {
      const why = await recoveryInvalidReason(row);
      return refused(why ?? 'a local tool call is still running');
    }
    if (!currentOwner()) return false;
    await commit(append(current, row));
    return true;
  });
}

/** Stop consumes an exact durable claim once; the same document then sends.
 * Only the shared pickup schedule may reload a ticket that remains uncollected. */
export function advanceRecoveryInput(id: string, owner: string, conversationId: string,
  action: 'stop' | 'stopped' | 'settled' | 'close' | 'reloaded'): Promise<boolean> {
  return serial(async () => {
    const current = await load();
    const row = current.find(entry => entry.id === id && entry.state === 'browser' && entry.owner === owner &&
      entry.conversationId === conversationId && entry.sendAuthorizedAt === undefined);
    if (!row?.recovery || !await recoveryCurrent(row)) return false;
    const phase = row.recovery.phase;
    if (action === 'stop' && ((phase !== 'ready' && !(phase === 'stopping' && row.recovery.stopOwner !== owner)) || !row.silenceBoundary?.nativeBusy ||
        (row.silenceBoundary.listenUntil ?? Infinity) > Date.now())) return false;
    if (action === 'stopped' && phase !== 'stopping') return false;
    if (action === 'settled' && phase !== 'ready' && phase !== 'resumed') return false;
    if (action === 'close' && (phase !== 'stopping' || row.recovery.closedOnce)) return false;
    if (action === 'reloaded' && phase !== 'reloading') return false;
    const next: InputEntry = action === 'close'
      ? { ...row, state: 'queued', owner: null, offeredAt: undefined, completedTurnId: undefined,
          recovery: { ...row.recovery, phase: 'ready', reloadOwner: owner, closedOnce: true },
          error: 'Waiting for the exact provider chat to reopen and settle its Stop request.' }
      : action === 'reloaded'
      ? { ...row, state: 'queued', owner: null, offeredAt: undefined, completedTurnId: undefined,
          deliveryText: undefined, recovery: { ...row.recovery, phase: 'resumed', reloadOwner: owner } }
      : { ...row, recovery: { ...row.recovery, phase: action === 'stop' ? 'stopping' : 'reloading',
            ...(action === 'stop' ? { stopOwner: owner } : {}) },
          ...(action === 'stopped' || action === 'settled' ? { nativeRecovery: { turnId: row.silenceBoundary!.turnId,
            questionId: row.recovery.questionId, phase: 'ready-to-refresh' as const } } : {}) };
    await commit(current.map(entry => entry === row ? next : entry));
    // Recording can accept resumed work while this write is pending. A written
    // Stop claim is spent even when its permission was revoked before publication.
    return recoveryCurrent(next);
  });
}

async function inputRefreshCurrent(row: InputEntry): Promise<boolean> {
  const recovery = row.nativeRecovery;
  if (!recovery || !row.sessionId || !row.conversationId || row.cancelledByUser || isChatBlocked(row.conversationId)) return false;
  const session = await getSession(row.sessionId);
  if (session?.conversationId !== row.conversationId || (session.activeTurnId && session.activeTurnId !== recovery.turnId) ||
      await conversationWasSuperseded(row.conversationId)) return false;
  const [end] = await readRecentEvents(row.sessionId, 1, { kinds: ['turn_start', 'turn_end'] });
  if (end?.kind !== 'turn_end' || end.turnId !== recovery.turnId ||
      !['completed', 'stopped', 'failed', 'interrupted'].includes(end.outcome)) return false;
  const question = await readLatestUserMessage(row.sessionId, recovery.turnId);
  return question?.messageId === recovery.questionId && (!row.recovery || await recoveryCurrent(row));
}

/** Navigation is a separately spent stage before the original continuation's Send. */
export function advanceInputRefresh(id: string, owner: string, conversationId: string,
  action: 'dispatch' | 'ready'): Promise<boolean> {
  return serial(async () => {
    const current = await load();
    const row = current.find(entry => entry.id === id && entry.state === 'browser' && entry.owner === owner &&
      entry.conversationId === conversationId && entry.requiresAuthorization === true && entry.sendAuthorizedAt === undefined);
    if (!row?.nativeRecovery || !await inputRefreshCurrent(row)) return false;
    if (action === 'dispatch' && row.nativeRecovery.phase !== 'ready-to-refresh') return false;
    if (action === 'ready' && (row.nativeRecovery.phase !== 'refresh-dispatched' || row.nativeRecovery.refreshOwner !== owner)) return false;
    const next: InputEntry = action === 'dispatch'
      ? { ...row, nativeRecovery: { ...row.nativeRecovery, phase: 'refresh-dispatched', refreshOwner: owner } }
      : { ...row, state: 'queued', owner: null, offeredAt: undefined, completedTurnId: undefined,
          nativeRecovery: { ...row.nativeRecovery, phase: 'ready' },
          ...(row.recovery ? { recovery: { ...row.recovery, phase: 'resumed', reloadOwner: owner } } : {}) };
    await commit(current.map(entry => entry === row ? next : entry));
    return inputRefreshCurrent(next);
  });
}

/** File on the existing outbox row, never in a parallel retry/ticket ledger. */
export function fileSilenceInput(sessionId: string, conversationId: string, turnId: string, currentOwner: () => boolean, listenUntil?: number): Promise<boolean> {
  return serial(async () => {
    const current = await load();
    const session = await getSession(sessionId);
    if (!currentOwner() || !session || session.conversationId !== conversationId || isChatBlocked(conversationId) ||
        session.origin?.kind === 'worker' || session.origin?.kind === 'helper' || inFlightToolCalls(conversationId) > 0) return false;
    const [boundary] = await readRecentEvents(sessionId, 1, { kinds: ['turn_start', 'turn_end'] });
    // The producer's exact MCP grant and elapsed silence window own this pickup;
    // a provider-authored end may already have closed the recorder's projection.
    if (!boundary || boundary.turnId !== turnId || (boundary.kind !== 'turn_start' && boundary.kind !== 'turn_end')) return false;
    if (!await turnHasMcpCall(sessionId, conversationId, turnId) || !currentOwner()) return false;
    if (current.some(row => row.sessionId === sessionId &&
      (consumedTurn(row, turnId) || (row.silenceBoundary?.turnId === turnId && row.state === 'browser')))) return true;
    if (current.some(row => row.sessionId === sessionId && (row.state === 'browser' || row.state === 'tool'))) return false;
    const candidates = ordered(current).filter(row => row.sessionId === sessionId && row.state === 'queued');
    const row = candidates.find(row => manualInput(row) && row.offeredAt === undefined && row.dueAt <= Date.now()) ?? candidates.find(queuedFollowup);
    if (!row || !queuedAfterTurn(row, session)) return false;
    if (row.recovery) return true; // Its frozen source and conditional busy deadline belong to the outbox.
    const [work] = await readRecentEvents(sessionId, 1, { kinds: INPUT_WORK_KINDS });
    if (!work || !currentOwner()) return false;
    const previous = current.find(entry => entry.sessionId === sessionId && entry.silenceBoundary?.turnId === turnId)?.silenceBoundary;
    const listening = Math.max(listenUntil ?? 0, previous?.listenUntil ?? 0);
    if (row.silenceBoundary?.turnId === turnId && row.silenceBoundary.workSeq === workSequence(work) &&
        (row.silenceBoundary.listenUntil ?? 0) === listening) return true;
    await commit(current.map(entry => entry === row ? { ...entry,
      silenceBoundary: { turnId, conversationId, workSeq: workSequence(work), acceptedAt: previous ? previous.acceptedAt : Date.now(), ...(listening ? { listenUntil: listening } : {}), ...(previous?.nativeBusy ? { nativeBusy: true } : {}) } }
      : entry.sessionId === sessionId && entry.state === 'queued' && entry.silenceBoundary?.turnId === turnId ? { ...entry, silenceBoundary: undefined } : entry));
    return true;
  });
}

/** Native Stop after refresh or settled failure extends listening, never Send authority. */
export function deferSilenceInput(id: string, conversationId: string, turnId: string): Promise<boolean> {
  return serial(async () => {
    const current = await load();
    const row = current.find(entry => entry.id === id && entry.state === 'queued' && entry.offeredAt === undefined);
    const session = row?.sessionId ? await getSession(row.sessionId) : null;
    if (!row?.sessionId || session?.conversationId !== conversationId || await eligibleStageEnd(row) !== turnId) return false;
    let boundary = row.silenceBoundary;
    if (!boundary) {
      // A manual failed-view send can be offered before automatic refresh. Its
      // first real busy rejection owns the same per-input delay, without MCP debt.
      const [end] = await readRecentEvents(row.sessionId, 1, { kinds: ['turn_start', 'turn_end'] });
      if (!manualInput(row) || end?.kind !== 'turn_end' || end.turnId !== turnId || end.outcome !== 'failed' || end.reason !== 'thinking_failed') return false;
      const [work] = await readRecentEvents(row.sessionId, 1, { kinds: INPUT_WORK_KINDS });
      if (!work) return false;
      boundary = { conversationId, turnId, workSeq: workSequence(work), acceptedAt: Date.now() };
    }
    if (boundary.conversationId !== conversationId || boundary.turnId !== turnId) return false;
    if (row.recovery && boundary.nativeBusy) return false; // One half-window, never a rolling extension.
    await commit(current.map(entry => entry === row ? { ...row,
      silenceBoundary: { ...boundary!, listenUntil: row.recovery
        ? row.recovery.busyUntil
        : Date.now() + recoveryBusyMs(session.selectedModel?.conversationId === conversationId &&
            isProModel(session.selectedModel.model, session.selectedModel.reasoningEffort)), nativeBusy: true } } : entry));
    return true;
  });
}

function withoutSilenceClaim(row: InputEntry, preserveBoundary = false, recoveryReason = 'new activity'): InputEntry {
  if (row.recovery) return { ...row, state: 'cancelled', error: `Automatic Continue cancelled: ${recoveryReason}.` };
  return { ...row, state: 'queued', owner: null, silenceBoundary: preserveBoundary ? row.silenceBoundary : undefined, completedTurnId: undefined,
    ...(manualInput(row) ? { transportIntent: 'tool' } : {}),
    companionInputId: undefined, offeredAt: undefined, sendAuthorizedAt: undefined, requiresAuthorization: undefined, deliveryText: undefined, error: undefined };
}
/** New work revokes an unspent ticket. Authorized sends retain custody until their exact receipt/failure. */
export function revokeSilenceInputs(sessionId: string, recoveryReason = 'new activity'): Promise<void> {
  return serial(async () => {
    const current = await load();
    const next = current.map(row => row.sessionId === sessionId && (row.silenceBoundary || row.completedTurnId) &&
      (row.state === 'queued' || (row.state === 'browser' && row.sendAuthorizedAt === undefined))
      ? withoutSilenceClaim(row, false, recoveryReason) : row);
    if (next.some((row, index) => row !== current[index])) await commit(next);
  });
}

/** Metadata only. Text is disclosed to one document only after an exclusive durable claim. */
async function completedStageBoundary(entry: InputEntry, current: InputEntry[]): Promise<string | null> {
  if (!entry.sessionId || !queuedFollowup(entry)) return null;
  // Match the displayed order. A finish-only/file/delayed head cannot be silently
  // skipped by a later after-turn row just because that transport is ready first.
  const first = ordered(current).find(row => row.sessionId === entry.sessionId && queuedFollowup(row) && row.state === 'queued');
  if (first?.id !== entry.id || first.dueAt > Date.now() || !await browserInputAllowed(first)) return null;
  const turnId = await eligibleStageEnd(entry);
  if (!turnId) return null;
  // A deferred ticket still owns this boundary. Later queue rows cannot overtake it.
  if (current.some(row => row !== entry && row.sessionId === entry.sessionId && row.state === 'queued' &&
      row.silenceBoundary?.turnId === turnId)) return null;
  if (current.some(row => row.sessionId === entry.sessionId && (consumedTurn(row, turnId) || row.state === 'tool' || row.state === 'browser'))) return null;
  if (current.some(row => row.sessionId === entry.sessionId && !queuedFollowup(row) && row.purpose !== 'decision' &&
      row.dueAt <= Date.now() && ['queued', 'browser', 'tool'].includes(row.state))) return null;
  return turnId;
}
export function pendingBrowserInputs(): Promise<Array<{ id: string; conversationId: string | null; chatProvider?: ChatProvider; steerTurnId?: string; warmupRecovery?: ReturnType<typeof warmupRecoveryView>; recovery?: { questionId: string; stop: boolean; phase?: NonNullable<InputEntry['recovery']>['phase'] }; silenceTurnId?: string; directTurn?: InputEntry['directTurn']; supersededConversationId?: string; lifetime?: 'temporary-planner'; project?: string }>> {
  return serial(async () => {
    const result: Array<{ id: string; conversationId: string | null; chatProvider?: ChatProvider; steerTurnId?: string; warmupRecovery?: ReturnType<typeof warmupRecoveryView>; recovery?: { questionId: string; stop: boolean; phase?: NonNullable<InputEntry['recovery']>['phase'] }; silenceTurnId?: string; directTurn?: InputEntry['directTurn']; supersededConversationId?: string; lifetime?: 'temporary-planner'; project?: string }> = [];
    const current = await load();
    for (const entry of ordered(current)) {
      if (companionOf(current, entry)) continue;
      if (!preparable(entry) || entry.dueAt > Date.now()) continue;
      if (queuedFollowup(entry) && entry.recovery?.phase !== 'stopping' && entry.nativeRecovery?.phase !== 'ready-to-refresh' && !(entry.state === 'browser' && entry.completedTurnId) && !(await completedStageBoundary(entry, current))) continue;
      if (!(await browserInputAllowed(entry))) continue;
      try {
        const conversationId = await target(entry);
        // A new chat of a project with a native Gemini Project opens in that Project and nowhere
        // else: it waits while the Project is being created or could not be, never the root.
        const chatgptProject = chatProviderCapabilities(chatProviderForConversation(conversationId, entry.chatProvider ?? getConfig().ui.chatProvider ?? DEFAULT_CHAT_PROVIDER)).nativeProjects && !conversationId && entry.projectId && entry.purpose !== 'decision' && !entry.lifetime
          ? (await getProject(entry.projectId))?.chatgpt : undefined;
        if (chatgptProject && chatgptProject.state !== 'linked') continue;
        const [end] = !entry.silenceBoundary && manualInput(entry) && entry.sessionId
          ? await readRecentEvents(entry.sessionId, 1, { kinds: ['turn_start', 'turn_end'] }) : [];
        const silenceTurnId = entry.silenceBoundary?.turnId ?? (end?.kind === 'turn_end' && end.outcome === 'failed' &&
          end.reason === 'thinking_failed' && end.turnId && await eligibleStageEnd(entry) === end.turnId ? end.turnId : undefined);
        result.push({ id: entry.id, conversationId, chatProvider: chatProviderForConversation(conversationId, entry.chatProvider ?? getConfig().ui.chatProvider ?? DEFAULT_CHAT_PROVIDER),
          ...(entry.recovery ? { recovery: { questionId: entry.recovery.questionId,
            ...(entry.recovery.phase === 'stopping' ? { phase: entry.recovery.phase } : {}),
            stop: entry.silenceBoundary?.nativeBusy === true && entry.recovery.phase === 'ready' } } : {}),
          ...(silenceTurnId ? { silenceTurnId } : {}),
          ...(entry.directTurn ? { directTurn: entry.directTurn } : {}),
          ...(entry.warmupRecovery ? { warmupRecovery: warmupRecoveryView(entry.warmupRecovery) } : {}),
          ...(entry.steerTurnId ? { steerTurnId: entry.steerTurnId } : {}),
          ...(entry.state === 'queued' && entry.purpose !== 'decision' && entry.sessionId && entry.conversationId && entry.conversationId !== conversationId
            ? { supersededConversationId: entry.conversationId } : {}),
          ...(entry.lifetime ? { lifetime: entry.lifetime } : {}),
          ...(chatgptProject?.state === 'linked' ? { project: chatgptProject.id } : {}) });
      } catch { /* blocked/deleted stays user-visible */ }
    }
    return result;
  });
}
export function claimBrowserInput(id: string, owner: string, conversationId: string | null, requiresAuthorization = false, browser: string | null = null,
  warmupSource?: WarmupDocument): Promise<InputEntry | null> {
  return serial(async () => {
    if (browser && !/^[a-z0-9]{16,64}$/.test(browser)) return null;
    let current = await load();
    let entry = current.find((row) => row.id === id);
    if (!entry || !preparable(entry) || (entry.state === 'browser' && !requiresAuthorization) || entry.dueAt > Date.now() || !owner) return null;
    if (entry.steerTurnId && entry.directTurn?.questionId && !requiresAuthorization) return null;
    if (entry.warmupRecovery) {
      if (!requiresAuthorization || !owner.startsWith(`${warmupSource?.tab_id}:${warmupSource?.document_id}:`)) return null;
      const adopted = adoptWarmupRecovery(entry.warmupRecovery, owner, browser, warmupSource, conversationId);
      if (!adopted || !entry.opening || entry.sendAuthorizedAt !== undefined || entry.deliveredAt !== undefined) return null;
      if (conversationId && entry.conversationId === null) {
        if (isChatBlocked(conversationId) || await conversationWasSuperseded(conversationId)) return null;
        const attached = await findSessionByConversation(conversationId);
        if (attached && attached.id !== entry.sessionId) return null;
      }
      // Persist candidate document custody, not native conversation identity. The
      // replacement adapter must prove its retained warmup before /gemini/binding
      // attaches the reserved session. A URL marker alone cannot rebind history.
      // A failed metadata write cannot let
      // another reloaded document claim a second adoption or refund navigation.
      const successor = { ...entry, owner, warmupRecovery: adopted };
      await commit(current.map(row => row === entry ? successor : row));
      current = entries!; entry = current.find(row => row.id === id)!;
    }
    if (entry.recovery && entry.recovery.phase !== 'stopping' && entry.nativeRecovery?.phase !== 'ready-to-refresh' && entry.state === 'browser' && entry.owner !== owner) return null;
    if (entry.state === 'browser' && entry.claimedBrowser && entry.claimedBrowser !== browser) return null;
    if (entry.recovery?.reloadOwner === owner) return null;
    if (entry.nativeRecovery?.phase === 'ready' && entry.nativeRecovery.refreshOwner === owner) return null;
    if (companionOf(current, entry)) return null;
    const completedTurnId = entry.state === 'browser' ? entry.completedTurnId : queuedFollowup(entry)
      ? await completedStageBoundary(entry, current) : manualInput(entry) ? await eligibleStageEnd(entry) : undefined;
    if (queuedFollowup(entry) && entry.recovery?.phase !== 'stopping' && entry.nativeRecovery?.phase !== 'ready-to-refresh' && !completedTurnId) return null;
    const currentTarget = await target(entry);
    const unboundWarmup = currentTarget === null && entry.opening && entry.warmupRecovery &&
      (conversationId === null || entry.warmupRecovery.conversationId === conversationId);
    if (currentTarget !== conversationId && !unboundWarmup) return null;
    const deliveryConversation = unboundWarmup ? null : conversationId;
    if (!(await browserInputAllowed(entry))) return null;
    if (entry.purpose === 'decision' && !decisionWaiters.has(id)) return null;
    if (entry.projectId) await projectWorkspace(entry.projectId);
    if (entry.sessionId) {
      if (current.some((row) => !sameDelivery(entry, row) && row.sessionId === entry.sessionId && ['browser', 'tool'].includes(row.state))) return null;
      const first = ordered(current).find((row) => row.sessionId === entry.sessionId && row.state === 'queued' && queuedFollowup(row) === queuedFollowup(entry) && row.dueAt <= Date.now());
      // Follow-ups were already elected by completedStageBoundary with live
      // transport eligibility. Direct messages retain their separate FIFO.
      if (entry.state === 'queued' && !queuedFollowup(entry) && first !== entry) return null;
    }
    // The completion appendix is mandatory text too: budget it before optional AGENTS.md,
    // then freeze the complete message once. A repeated claim keeps those exact bytes.
    const session = entry.sessionId ? await getSession(entry.sessionId) : null;
    const withoutMention = await imageRequestWithoutMention(entry, session);
    // Freeze at most the visible next checkpoint into the same exclusive browser
    // claim. Both authored rows remain intact and share one acceptance receipt.
    const queueHead = session && manualInput(entry) && entry.silenceBoundary && (entry.silenceBoundary.listenUntil ?? 0) <= Date.now() && entry.state === 'queued' &&
      await turnHasMcpCall(session.id, entry.silenceBoundary.conversationId, entry.silenceBoundary.turnId)
      ? ordered(current).find(row => row.sessionId === entry.sessionId && queuedFollowup(row) && row.state === 'queued') : undefined;
    let companion = entry.companionInputId ? current.find(row => row.id === entry.companionInputId)
      : queueHead && session && queuedAfterTurn(queueHead, session) && !queueHead.finishOwner && queueHead.purpose !== 'decision' && queueHead.attachmentDelivery !== 'tool' ? queueHead : undefined;
    if (entry.companionInputId && (!companion || companion.state !== 'browser' || companion.owner !== entry.owner || companion.sessionId !== entry.sessionId)) return null;
    // An optional checkpoint cannot make an otherwise deliverable correction too
    // large. Leave that exact head queued; never skip it to collect a later one.
    if (companion && !entry.companionInputId &&
        (!inputArgs.shape.images.safeParse([...entry.images ?? [], ...companion.images ?? []]).success ||
         !inputArgs.shape.attachments.safeParse([...entry.attachments ?? [], ...companion.attachments ?? []]).success)) companion = undefined;
    const observed = session?.selectedModel?.conversationId === conversationId ? session?.selectedModel : null;
    const selection = browserInputModel(entry);
    const settings = getConfig().ui;
    const instruction = settings.finishTool && entry.purpose !== 'decision' && session?.origin?.kind !== 'worker' && session?.origin?.kind !== 'helper' &&
      isAstraModel(selection.model ?? observed?.model, selection.model ? selection.reasoningEffort ?? undefined : observed?.reasoningEffort)
      ? finishInstruction(settings.finishLeadMinutes) : '';
    const suffix = instruction && !entry.text.includes(instruction) ? '\n\n' + instruction : '';
    let claimed: InputEntry;
    const prepareClaim = (checkpoint?: InputEntry) => prepare({ ...combinedInput(entry, checkpoint), ...(checkpoint ? { companionInputId: checkpoint.id } : {}), ...(completedTurnId ? { completedTurnId } : {}),
      ...(entry.transportIntent === 'tool' ? { transportIntent: 'browser' } : {}),
      state: 'browser', owner, conversationId: deliveryConversation, offeredAt: entry.offeredAt ?? Date.now(), requiresAuthorization,
      claimedBrowser: browser ?? undefined }, suffix, withoutMention && !checkpoint &&
        chatProviderForConversation(conversationId, entry.chatProvider ?? DEFAULT_CHAT_PROVIDER) === 'gemini');
    try {
      try { claimed = await prepareClaim(companion); }
      catch (error) {
        if (!companion || entry.companionInputId || !(error instanceof Error) || !error.message.includes('Prepared message exceeds the delivery limit')) throw error;
        companion = undefined;
        claimed = await prepareClaim();
      }
      claimed = { ...claimed, text: entry.text, images: entry.images, attachments: entry.attachments };
    }
    catch (error) {
      // A never-handed-out oversized legacy row needs a visible terminal result,
      // not an endless series of browser claims. Existing claims keep their receipt.
      if (entry.state === 'queued') await commit(current.map(row => row === entry
        ? { ...entry, state: 'failed', error: (error as Error).message.slice(0, 200) } : row));
      throw error;
    }
    if (entry.steerTurnId && entry.directTurn?.questionId && !await browserInputAllowed(entry)) return null;
    await transition(current, current.map((row) => row === entry ? claimed : row === companion ? { ...row,
      state: 'browser', owner, conversationId, offeredAt: claimed.offeredAt, requiresAuthorization, completedTurnId: claimed.completedTurnId } : row),
      entry.state === 'queued' && entry.automation && conversationId && entry.purpose !== 'decision' ? [claimed] : [], 'before-send');
    if (entry.steerTurnId && entry.directTurn?.questionId && !await browserInputAllowed(claimed)) return null;
    if (!requiresAuthorization && completedTurnId && entry.sessionId && conversationId)
      await consumeGoalReplyForInputNow(conversationId, entry.sessionId, completedTurnId);
    logInfo(`input ${id}: browser claimed after ${Math.max(0, Date.now() - entry.createdAt)} ms`);
    const omitMention = withoutMention && !companion;
    if (omitMention) logInfo(`input ${id}: asks for an image, so it goes out without the Core mention`);
    return { ...combinedInput(claimed, companion), ...selection, text: claimed.deliveryText ?? claimed.text,
      ...(omitMention ? { coreMention: false as const } : {}) };
  });
}
/**
 * The person's own message asking Gemini for a picture goes out without the Core mention: Gemini
 * switches its image tool off for a message that mentions an app (see image-request.ts). Generated
 * messages (Goal, Loop, recovery, workers, the Goal helper) keep the mention as before.
 */
async function imageRequestWithoutMention(entry: InputEntry, session: SessionSummary | null, companion?: InputEntry): Promise<boolean> {
  // A combined message also carries the next queued instruction, which may need the app.
  if (companion || entry.purpose === 'decision' || entry.recovery || entry.finishOwner || (entry.authoredSource ?? 'text') !== 'text') return false;
  if (session?.origin?.kind === 'worker' || session?.origin?.kind === 'helper') return false;
  const attachedImage = (entry.images?.length ?? 0) > 0 || (entry.attachments ?? []).some(file => file.mimeType.startsWith('image/'));
  // Shortly after Gemini made a picture, "make it brighter" changes that picture: the picture
  // answered one of the last two questions, so one failed edit in between still counts.
  let afterImage = false;
  if (session) {
    const recent = await readRecentEvents(session.id, 64, { kinds: ['user_message', 'native_image'] }).catch(() => []);
    const questions = recent.flatMap((event, index) => event.kind === 'user_message' ? [index] : []);
    const since = questions.length >= 2 ? questions.at(-2)! : questions.at(-1);
    afterImage = since !== undefined && recent.slice(since + 1).some(event => event.kind === 'native_image' && event.providerStatus !== 'in_progress');
  }
  return asksForImage(entry.text, { attachedImage, afterImage });
}
/** Initial provider binding uses the same reserved session as local admission. */
async function bindOpening(entry: InputEntry, conversationId: string): Promise<boolean> {
  if (!entry.opening || !entry.sessionId) return false;
  if (entry.chatProvider && chatProviderForConversation(conversationId) !== entry.chatProvider) return false;
  if (entry.conversationId && entry.conversationId !== conversationId) return false;
  if (await conversationWasSuperseded(conversationId)) return false;
  await materializeOpening(entry);
  const session = await getSession(entry.sessionId);
  if (!session || (session.conversationId && session.conversationId !== conversationId)) return false;
  const provider = chatProviderForConversation(conversationId);
  const strictAtAuthoritativeBind = !session.conversationId && providerTrustValidationEnabled(getConfig().multiAgent, provider);
  let boundSessionNow = false;
  if (!session.conversationId) {
    if (!await rebindSession(session.id, null, conversationId)) return false;
    boundSessionNow = true;
  }
  // This is the first exact provider attachment that can prove the chat was opened by the CoS
  // composer: the durable outbox row is an opening, the browser proved its exact owner/id pair,
  // and this operation committed the reserved session's null -> conversation bind while strict
  // mode was already on. Recovered outbox rows whose session attached earlier may reconcile their
  // row here, but that stale first outbox binding cannot mint Trust. Direct/browser-created chats
  // never traverse this boundary. Keep strict-off openings out of the explicit Trust registry.
  if (boundSessionNow && strictAtAuthoritativeBind && providerTrustValidationEnabled(getConfig().multiAgent, provider)) {
    if (!deliveryHooks?.trustOpening || !await deliveryHooks.trustOpening(session.id, conversationId)) return false;
  }
  return true;
}
/**
 * Gemini assigns a route only after a controlled tool-free warmup. The paired
 * companion proves that route belongs to this exact claimed opening document.
 * Attach its already reserved session before issuing MCP credentials; this is not
 * authorization or acknowledgement of the person's task Send.
 */
export function bindGeminiOpeningInput(id: string, owner: string, conversationId: string): Promise<string | null> {
  return serial(async () => {
    if (!owner || !/^[a-f0-9]{16}$/.test(conversationId)) return null;
    const current = await load();
    const entry = current.find(row => row.id === id && row.owner === owner && row.state === 'browser');
    if (!entry?.opening || !entry.sessionId || entry.purpose === 'decision' || !entry.requiresAuthorization ||
        (entry.warmupRecovery && (entry.warmupRecovery.successorOwner !== owner || Date.now() >= entry.warmupRecovery.expiresAt ||
          (entry.warmupRecovery.conversationId !== undefined && entry.warmupRecovery.conversationId !== conversationId))) ||
        entry.sendAuthorizedAt !== undefined || entry.deliveredAt !== undefined || companionOf(current, entry) ||
        (entry.conversationId && entry.conversationId !== conversationId)) return null;
    const session = await getSession(entry.sessionId);
    if (!session || session.origin?.kind !== 'desktop' ||
        (session.conversationId && session.conversationId !== conversationId) ||
        await conversationWasSuperseded(conversationId) || isChatBlocked(conversationId)) return null;
    const attached = await findSessionByConversation(conversationId);
    if (attached && attached.id !== session.id) return null;
    const bound = { ...entry, conversationId,
      ...(entry.warmupRecovery ? { warmupRecovery: { ...entry.warmupRecovery, conversationId } } : {}) };
    // Session metadata commits first. If the outbox write fails or the app stops
    // between them, the same exact claim repairs its row; it cannot create a peer.
    if (!await bindOpening(bound, conversationId)) return null;
    if (entry.conversationId !== conversationId) await commit(current.map(row => row === entry ? bound : row));
    return session.id;
  });
}

/** The canonical outbox claim is the sole issuer of per-input MCP custody. */
export function prepareGeminiInputClaim(id: string, owner: string, conversationId: string, browser: string): Promise<{ sessionId: string; input: GeminiBindingInput } | null> {
  return serial(async () => {
    const current = await load(), row = current.find(entry => entry.id === id && entry.owner === owner);
    if (!row?.sessionId || row.claimedBrowser !== browser || row.conversationId !== conversationId ||
        !row.requiresAuthorization || !Number.isFinite(row.offeredAt) || row.purpose === 'decision' ||
        !['browser', 'sent'].includes(row.state) || companionOf(current, row) || isChatBlocked(conversationId)) return null;
    const session = await getSession(row.sessionId);
    if (session?.conversationId !== conversationId || entries?.find(entry => entry.id === id) !== row) return null;
    return { sessionId: row.sessionId, input: { id, owner, browser, offeredAt: row.offeredAt! } };
  });
}

export type GeminiInputBindingStatus = { state: 'pending' | 'invalid'; accepted?: true } | { state: 'ready'; turn: GeminiInputTurn };
/** Resolve only the exact claimed input's committed native Send/history receipt. */
export async function chatgptInputBindingStatus(proof: GeminiBindingInput): Promise<LocalBindingStatus> {
  const row = (await load()).find(entry => entry.id === proof.id);
  if (!row || row.owner !== proof.owner || row.claimedBrowser !== proof.browser || row.offeredAt !== proof.offeredAt ||
      !row.requiresAuthorization || !['browser', 'sent'].includes(row.state)) return { state: 'invalid' };
  if (!row.conversationId) return row.state === 'browser' ? { state: 'pending' } : { state: 'invalid' };
  if (chatProviderForConversation(row.conversationId) !== 'chatgpt' || !row.sessionId) return { state: 'invalid' };
  if (isChatBlocked(row.conversationId)) return { state: 'blocked' };
  const result = await geminiInputBindingStatus(proof, row.conversationId, row.sessionId);
  if (result.state === 'invalid' && isChatBlocked(row.conversationId)) return { state: 'blocked' };
  return result.state === 'ready' ? { ...result, conversationId: row.conversationId, sessionId: row.sessionId } : result;
}
/** Read committed custody without re-entering the input queue: tool delivery already holds it.
 * Every awaited read is followed by the same exact row check; no latest-receipt/time inference. */
export async function geminiInputBindingStatus(proof: GeminiBindingInput, conversationId: string, sessionId: string): Promise<GeminiInputBindingStatus> {
  const current = await load(), row = current.find(entry => entry.id === proof.id);
  const owns = () => entries?.find(entry => entry.id === proof.id) === row;
  if (!row || row.owner !== proof.owner || row.claimedBrowser !== proof.browser || row.offeredAt !== proof.offeredAt ||
      row.sessionId !== sessionId || row.conversationId !== conversationId || !row.requiresAuthorization ||
      row.purpose === 'decision') return { state: 'invalid' };
  // This exact durable native receipt still supersedes the source even if its
  // new task is later cancelled or replaced. It never authorizes that new task.
  const accepted = ['sent', 'cancelled'].includes(row.state) && row.sendAuthorizedAt !== undefined && row.deliveredAt !== undefined &&
    row.historyAnchored && !!row.historySeq && !!row.messageId ? { accepted: true as const } : {};
  // A late exact provider ACK settles transport truth, but it cannot undo an explicit local
  // cancellation. Keep the receipt available as predecessor/supersession evidence while refusing
  // to turn the cancelled task credential into an executable binding.
  if (row.cancelledByUser) return { state: 'invalid', ...accepted };
  if (!['browser', 'sent'].includes(row.state) || isChatBlocked(conversationId)) return { state: 'invalid', ...accepted };
  const session = await getSession(sessionId);
  if (!owns() || !session) return { state: 'pending' };
  if (session.conversationId !== conversationId) return { state: 'invalid' };
  if (row.state === 'browser' || row.sendAuthorizedAt === undefined || row.deliveredAt === undefined ||
      !row.historyAnchored || !row.historySeq || !row.messageId) return { state: 'pending' };
  const question = await readLatestUserMessage(sessionId);
  if (!owns()) return { state: 'pending' };
  if (!question || positionOf(question) < row.historySeq) return { state: 'pending' };
  if (question.messageId !== row.messageId || question.inputId !== row.id || positionOf(question) !== row.historySeq) return { state: 'invalid', ...accepted };
  const turns = Object.entries(session.timelineTurns ?? {}).filter(([, turn]) => turn.questionId === row.messageId);
  // The original question cannot lend its grant to Regenerate/a successor generation.
  if (turns.length > 1 || turns.some(([, turn]) => turn.endOrigin !== undefined)) return { state: 'invalid', ...accepted };
  if (!session.activeTurnId || !turns.length) return { state: 'pending', accepted: true };
  const active = session.timelineTurns?.[session.activeTurnId];
  if (!active || active.questionId !== row.messageId)
    return active && active.origin >= row.historySeq ? { state: 'invalid', ...accepted } : { state: 'pending', accepted: true };
  return { state: 'ready', turn: { inputId: row.id, messageId: row.messageId, historySeq: row.historySeq, turnId: session.activeTurnId } };
}

/** Bind exact opening/project ownership before the document publishes request evidence. */
export function bindBrowserInputProject(id: string, owner: string, conversationId: string): Promise<boolean> {
  return serial(async () => {
    if (!owner || !/^[0-9a-z-]{8,256}$/i.test(conversationId)) return false;
    const current = await load();
    const entry = current.find(row => row.id === id && row.owner === owner);
    if (!entry || !['browser', 'sent'].includes(entry.state) || (!entry.opening && !entry.projectId) || entry.purpose === 'decision') return false;
    if (entry.chatProvider && chatProviderForConversation(conversationId) !== entry.chatProvider) return false;
    if (entry.requiresAuthorization && entry.sendAuthorizedAt === undefined) return false;
    if (entry.conversationId && entry.conversationId !== conversationId) return false;
    if (await conversationWasSuperseded(conversationId)) return false;
    const bound = { ...entry, conversationId };
    if (!entry.conversationId) await commit(current.map(row => row === entry ? bound : row));
    if (entry.opening) return bindOpening(bound, conversationId);
    // Legacy pre-reservation project inputs keep their exact receipt binding.
    const heldSessionId = entry.sessionId ?? entry.deliveredSessionId;
    const session = heldSessionId ? await getSession(heldSessionId) :
      await findSessionByConversation(conversationId, { requireUnique: true }) ?? await createSession({ conversationId, title: userTitle(entry.text, entry.text), titleSource: 'fallback' });
    if (!session || session.conversationId !== conversationId) return false;
    await assignSessionProject(session.id, entry.projectId!);
    const latest = await load();
    await commit(latest.map(row => row.id === id ? { ...row, deliveredSessionId: session.id } : row));
    return true;
  });
}
export function acknowledgeBrowserInput(id: string, owner: string, conversationId?: string | null, messageId?: string, beforeChanged?: () => void): Promise<boolean> {
  return serial(async () => {
    const current = await load();
    const entry = current.find((row) => row.id === id && row.owner === owner);
    if (entry && companionOf(current, entry)) return false;
    if (!owner || !entry || !['browser', 'sent', 'decision', 'cancelled'].includes(entry.state) ||
      (entry.state === 'cancelled' && entry.purpose === 'decision')) return false;
    if (conversationId !== undefined && !(entry.lifetime === 'temporary-planner' && conversationId === null) && (!conversationId || !/^[0-9a-z-]{8,256}$/i.test(conversationId))) return false;
    if (conversationId && entry.conversationId && entry.conversationId !== conversationId) return false;
    // A fresh user send is not complete until Gemini assigns its exact conversation.
    // Keep the authored sessionId unchanged so retrying the original enqueue is idempotent.
    if ((entry.opening || !entry.sessionId) && entry.purpose !== 'decision' && !conversationId && !entry.conversationId) return false;
    if (messageId !== undefined && (!messageId || messageId.length > 256)) return false;
    if ((entry.state !== 'browser' && entry.state !== 'cancelled') || (entry.state === 'cancelled' && entry.deliveredAt !== undefined)) { await publishHistory(); return true; }
    const deliveredConversation = conversationId ?? entry.conversationId;
    if (entry.opening && deliveredConversation) {
      if (entry.state === 'cancelled' && entry.requiresAuthorization && entry.sendAuthorizedAt === undefined) return false;
      if (!await bindOpening(entry, deliveredConversation)) return false;
    }
    if (!entry.sessionId && entry.purpose !== 'decision' && deliveredConversation) {
      await noteChatOrigin(deliveredConversation, { kind: 'desktop', fromSessionId: null, agentId: null, task: '' });
    }
    const delivered = entry.sessionId ? await getSession(entry.sessionId) : deliveredConversation
      ? await findSessionByConversation(deliveredConversation, { requireUnique: true }) : null;
    if (entry.purpose === 'decision' && entry.lifetime !== 'temporary-planner' && deliveredConversation) await deliveryHooks?.bindHelper?.(deliveredConversation, entry.decisionSourceSessionId ?? null);
    const acknowledged: InputEntry = { ...entry, conversationId: deliveredConversation,
      deliveredSessionId: delivered?.id ?? null, state: entry.purpose === 'decision' ? 'decision' : 'sent',
      // A provider receipt is stronger than an earlier local timeout/cancel tombstone. Preserve
      // cancelledByUser as historical intent, but never keep presenting an exact delivered message
      // as unsent/unconfirmed after its native receipt has arrived.
      error: undefined,
      // A user cancellation that lost the race with native Send must not resurrect automation or
      // later plan checkpoints merely because the provider eventually proved the first delivery.
      ...(entry.state === 'cancelled' && entry.cancelledByUser && entry.stages?.length ? { stagesApplied: true } : {}),
      ...(messageId ? { messageId } : {}), deliveredAt: Date.now() };
    await transition(current, current.map((row) => row === entry ? acknowledged : row.id === entry.companionInputId ? { ...row,
      state: acknowledged.state, error: acknowledged.error, deliveredSessionId: acknowledged.deliveredSessionId,
      messageId: acknowledged.messageId, deliveredAt: acknowledged.deliveredAt } : row),
      entry.state !== 'cancelled' && (entry.opening || !entry.sessionId) && entry.automation && deliveredConversation && entry.purpose !== 'decision' ? [acknowledged] : [], 'after-send', beforeChanged);
    if (entry.completedTurnId && entry.sessionId && deliveredConversation)
      await consumeGoalReplyForInputNow(deliveredConversation, entry.sessionId, entry.completedTurnId);
    logInfo(`input ${id}: browser acknowledged after ${Math.max(0, Date.now() - entry.createdAt)} ms`);
    await publishHistory();
    return true;
  });
}
/** A later exact call proves receipt of an earlier tool response, never of a queued task. */
function toolInputScopeMatches(entry: InputEntry, binding?: LocalBindingEvidence): boolean {
  if (!binding && !geminiInput(entry.conversationId)) return !entry.toolGeminiOffer;
  const offer = entry.toolGeminiOffer, turn = binding?.inputTurn, held = offer?.inputTurn;
  return !!turn && offer?.bindingId === binding?.bindingId && held?.inputId === turn.inputId &&
    held.messageId === turn.messageId && held.historySeq === turn.historySeq && held.turnId === turn.turnId;
}
function toolInputReceipt(entry: InputEntry, sessionId: string, conversationId: string, startedAt: number, binding?: LocalBindingEvidence): InputEntry {
  const deliveredAt = offered.get(entry.id);
  return entry.sessionId === sessionId && entry.conversationId === conversationId && entry.state === 'tool' &&
    toolInputScopeMatches(entry, binding) && deliveredAt !== undefined && startedAt > deliveredAt
    ? { ...entry, state: 'sent', messageId: `input:${entry.id}`, deliveredAt, historyRecorded: false } : entry;
}
/** Commit incoming receipt evidence before a handler decides whether user work remains. */
async function toolInputCaller(sessionId: string, conversationId: string, requestId: string | null | undefined, binding?: LocalBindingEvidence): Promise<boolean> {
  if (!binding && !geminiInput(conversationId)) return !!requestId;
  if (!binding?.inputTurn || binding.sessionId !== sessionId || binding.conversationId !== conversationId) return false;
  try { await validateLocalBinding(binding); return true; } catch { return false; }
}

export function acknowledgeToolInput(sessionId: string | null | undefined, conversationId: string | null | undefined, requestId: string | null | undefined, startedAt: number, binding?: LocalBindingEvidence): Promise<void> {
  return serial(async () => {
    if (!sessionId || !conversationId || isChatBlocked(conversationId) || !await toolInputCaller(sessionId, conversationId, requestId, binding)) return;
    if ((await getSession(sessionId))?.conversationId !== conversationId) return;
    const current = await load();
    const next = current.map(entry => toolInputReceipt(entry, sessionId, conversationId, startedAt, binding));
    if (!next.some((entry, index) => entry !== current[index])) return;
    await commit(next);
    for (const entry of next) if (terminal(entry)) offered.delete(entry.id);
    await publishHistory();
  });
}

export function offerToolInput(sessionId: string | null | undefined, conversationId: string | null | undefined, requestId: string | null | undefined, startedAt: number, finishBoundary = false, binding?: LocalBindingEvidence): Promise<ToolInputBatch> {
  return serial(async () => {
    const batch: ToolInputBatch = { messages: [], reminder: '' };
    if (!sessionId || !conversationId || isChatBlocked(conversationId) || !await toolInputCaller(sessionId, conversationId, requestId, binding)) return batch;
    const session = await getSession(sessionId);
    if (session?.conversationId !== conversationId) return batch;
    const finishSettings = getConfig().ui;
    finishBoundary = finishBoundary && finishSettings.finishTool === true && session.origin?.kind !== 'worker';
    const finishReminder = finishSettings.finishTool === true && !session.finishTurn?.released &&
      session.origin?.kind !== 'worker' && session.origin?.kind !== 'helper' &&
      session.selectedModel?.conversationId === conversationId && isAstraModel(session.selectedModel.model, session.selectedModel.reasoningEffort)
      ? finishInstruction(finishSettings.finishLeadMinutes) : '';
    const current = await load();
    // A claimed browser send owns this session until its send outcome is known.
    if (current.some((entry) => entry.sessionId === sessionId && entry.state === 'browser')) return batch;
    const head = ordered(current).find(row => row.sessionId === sessionId && queuedFollowup(row) &&
      ['queued', 'tool'].includes(row.state) && !terminal(toolInputReceipt(row, sessionId, conversationId, startedAt, binding)));
    const delivered: string[] = [];
    let inputTaken = false;
    let payloadBytes = Buffer.byteLength(TOOL_INPUT_HEADER);
    let payloadImages = 0;
    let payloadFull = false;
    const observedActivity = deliveryHooks?.activity?.(session);
    const activeToolTurn = session.activeTurnId ?? (observedActivity?.exact ? observedActivity.turnId : undefined);
    const prepareEntry = async (entry: InputEntry): Promise<InputEntry> => {
      if (entry.steerTurnId) return entry;
      if (entry.state === 'tool' && !toolInputScopeMatches(entry, binding)) return entry;
      if (entry.toolSteer && entry.state === 'queued' && session.activeTurnId !== entry.toolTurnId) return entry;
      if (entry.sessionId !== sessionId || entry.dueAt > Date.now()) return entry;
      if (entry.attachments?.length && entry.attachmentDelivery !== 'tool' && entry.delivery !== 'tool') return entry;
      if (entry.delivery === 'tool' && entry.toolTurnId !== activeToolTurn) return entry;
      // A message for the running turn goes through the composer only: in a tool result the model
      // never saw it (#1231). If the page cannot take it, it is sent once the turn has ended.
      if (entry.directTurn && entry.state === 'queued') return entry;
      if (entry.state === 'queued' && entry.delivery !== 'tool' && composerOnlyText(entry, session)) return entry;
      // Gemini may reuse one request id for the whole server turn. Receipt follows
      // the actual invocation start, never a change in that grouping id.
      const received = toolInputReceipt(entry, sessionId, conversationId, startedAt, binding);
      if (received !== entry) return received;
      if (payloadFull || (inputTaken && (entry.mode === 'finish' || entry.finishOwner)) || (entry.finishOwner && entry.createdAt >= startedAt)) return entry;
      if (entry.mode === 'finish' && !finishBoundary) return entry;
      if (entry.mode === 'finish' && entry !== head) return entry;
      // After-turn tasks own a future browser turn; they cannot block an explicit
      // Inject now message from the current tool response. Their own FIFO is unchanged.
      if ((entry.state === 'queued' && (entry.mode === 'finish' || entry.mode === 'auto')) || entry.state === 'tool') {
        let prepared: InputEntry;
        try { prepared = await prepare({ ...entry, conversationId }); }
        catch (error) { return { ...entry, state: 'failed', error: (error as Error).message.slice(0, 200) }; }
        const message = prepared.deliveryText ?? prepared.text;
        const reminder = finishReminder || batch.reminder || (entry.mode === 'finish' ? 'Work on this user task now.' : '');
        const messageBytes = Buffer.byteLength(message) + (inputTaken ? 2 : 0);
        const reminderBytes = reminder ? Buffer.byteLength(reminder) + 2 : 0;
        const images = [...entry.images ?? [], ...entry.toolImages ?? []];
        if (payloadBytes + messageBytes + reminderBytes > TOOL_INPUT_TEXT_BYTES || payloadImages + images.length > MAX_INPUT_IMAGES) { payloadFull = true; return entry; }
        payloadBytes += messageBytes;
        payloadImages += images.length;
        inputTaken = true;
        batch.messages.push({ text: message, images });
        batch.reminder = reminder;
        delivered.push(entry.id);
        return { ...prepared, state: 'tool', toolTurnId: entry.toolTurnId ?? session.activeTurnId ?? deliveryHooks?.activity?.(session).turnId,
          ...(binding ? { toolGeminiOffer: entry.toolGeminiOffer ?? { attribution: binding.attribution, bindingId: binding.bindingId, startedAt, inputTurn: binding.inputTurn } } : {}),
          offeredAt: entry.offeredAt ?? Date.now(), owner: entry.state === 'tool' ? entry.owner : requestId ?? null, conversationId };
      }
      return entry;
    };
    const next: InputEntry[] = [];
    for (const entry of ordered(current).sort((a, b) => Number(a.mode === 'finish' || !!a.finishOwner) - Number(b.mode === 'finish' || !!b.finishOwner))) next.push(await prepareEntry(entry));
    if (!await toolInputCaller(sessionId, conversationId, requestId, binding) || isChatBlocked(conversationId)) return { messages: [], reminder: '' };
    const recipient = await getSession(sessionId);
    if (recipient?.conversationId !== conversationId || next.some(entry => entry.toolSteer && entry.state === 'tool' &&
      current.some(prior => prior.id === entry.id && prior.state === 'queued') && recipient.activeTurnId !== entry.toolTurnId))
      return { messages: [], reminder: '' };
    if (next.some((entry, index) => entry !== current[index])) {
      const automated = next.filter((entry) => entry.state === 'tool' && entry.automation && current.some((row) => row.id === entry.id && row.state === 'queued'));
      await transition(current, next, automated, 'before-send');
    }
    for (const id of delivered) if (!offered.has(id)) offered.set(id, Date.now());
    for (const entry of next) if (terminal(entry)) offered.delete(entry.id);
    await publishHistory();
    return batch;
  });
}

export function resetInputForTests(): void { entries = null; chain = Promise.resolve(); offered.clear(); decisionWaiters.clear(); }

export async function pausedBrowserHelpers(): Promise<Array<{ id: string; sourceSessionId: string }>> {
  return (await listInputs()).filter(row => row.purpose === 'decision' && row.state === 'cancelled' && row.cancelledByUser === true && !row.conversationId && row.decisionSourceSessionId)
    .map(row => ({ id: row.id, sourceSessionId: row.decisionSourceSessionId! }));
}

/** A deliberate user action withdraws exactly one ambiguous attempt's retry fence.
 * Its old owner remains terminal forever; this never replays the previous send. */
export function authorizeBrowserHelperRetry(id: string, sourceSessionId: string): Promise<boolean> {
  return serial(async () => {
    const current = await load();
    const row = current.find(entry => entry.id === id && entry.decisionSourceSessionId === sourceSessionId
      && entry.purpose === 'decision' && entry.state === 'cancelled' && !entry.conversationId);
    if (!row || current.some(entry => entry.decisionSourceSessionId === sourceSessionId && !terminal(entry))) return false;
    await commit(current.map(entry => entry === row ? { ...entry, state: 'failed', error: 'User authorized a new helper' } : entry));
    return true;
  });
}

/**
 * Only a pre-send failure can be declared failed. An ambiguous click stays claimed, unless the
 * page reports that its receipt was never confirmed: that retires it as an uncertain send.
 */
/**
 * How long pages may keep withdrawing one automatic Continue before Send. Measured in #820: a page
 * that refuses for a reason it cannot get past released the same ticket about once a second for
 * many minutes, its text left in the composer. Past this, the Continue ends and the log says why.
 */
export const RECOVERY_WITHDRAW_LIMIT_MS = 3 * 60_000;

/**
 * Ends an automatic Continue that a page refuses before ever claiming it, because Gemini shows
 * the native final of its turn.
 *
 * Measured 2026-10-02: a Continue was filed for a turn whose final the app had missed. Every page
 * it was offered to saw that final and refused before claiming, and said nothing, so the withdraw
 * limit above never started, and the pickup schedule reloaded the chat every fifteen minutes for
 * six hours. A typed message is never ended here. Only an unsent, unclaimed automatic Continue is.
 */
export function endRecoveryInput(id: string, conversationId: string): Promise<boolean> {
  return serial(async () => {
    const current = await load();
    const row = current.find(entry => entry.id === id && entry.recovery && entry.state === 'queued' &&
      entry.offeredAt === undefined && entry.sendAuthorizedAt === undefined);
    if (!row?.sessionId || !row.recovery || (await getSession(row.sessionId))?.conversationId !== conversationId) return false;
    const error = 'Automatic Continue was not needed: the page shows a finished answer.';
    logWarn(`input ${row.id}: ${error}`);
    await commit(current.map(entry => entry === row
      ? { ...entry, state: 'cancelled', owner: null, error, recovery: { ...row.recovery!, ended: 'page-final' } } : entry));
    return true;
  });
}

export function failBrowserInput(id: string, owner: string, error: string, detail?: string): Promise<boolean> {
  return serial(async () => {
    const current = await load();
    const entry = current.find((row) => row.id === id && row.owner === owner && row.state === 'browser');
    if (!entry || companionOf(current, entry)) return false;
    if (entry.nativeRecovery?.phase === 'refresh-dispatched') return false;
    // These codes are emitted only by the pre-Send owner. A spent authorization
    // can never use this path to refund its Send authority.
    const waitingReason = detail === 'turn-progressed' || detail?.startsWith('turn-progressed-') ? 'answer-resumed'
      : detail === 'editor-unavailable' ? 'editor-unavailable'
      : detail === 'page-closed' || detail === 'left-chat' ? 'document-rebind' : null;
    if (waitingReason && entry.requiresAuthorization === true && entry.sendAuthorizedAt === undefined &&
        resumablePreparation(entry)) {
      await commit(current.map(row => sameDelivery(entry, row) ? deferPreparation(row, waitingReason) : row));
      return true;
    }
    // The page clicked Send and could not prove the result (#821). This is the outcome an
    // unreported send reaches in expireQueued, without the wait: the session is free again,
    // nothing is replayed, and a late exact receipt still confirms it (acknowledgeBrowserInput
    // accepts a cancelled row). Openings and Continue included: they held their chat until then.
    if (entry.sendAuthorizedAt !== undefined && error === RECEIPT_UNCONFIRMED) {
      logWarn(`input ${entry.id}: native Send was clicked, but its receipt was not confirmed`);
      await commit(current.map(row => sameDelivery(entry, row) ? { ...row, state: 'cancelled', error: UNCONFIRMED_SEND } : row));
      decisionWaiters.get(id)?.reject(new Error('goal_browser_send_failed: ' + UNCONFIRMED_SEND));
      decisionWaiters.delete(id);
      return true;
    }
    // Unlike an unconfirmed receipt, this is proof the click did not deliver: Gemini left the
    // exact text in its composer and showed no new user message, and the page has cleared that
    // draft. Seen when a message for the running turn was clicked in the second the turn ended.
    // One requeue sends it again; a second refusal is reported instead of retried forever.
    if (entry.sendAuthorizedAt !== undefined && error === SEND_NOT_TAKEN) {
      const retry = (entry.notTakenRetries ?? 0) === 0 && manualInput(entry) && !entry.recovery && !entry.opening &&
        entry.purpose !== 'decision' && !entry.lifetime;
      logWarn(`input ${entry.id}: The provider did not take the clicked Send; ${retry ? 'queued once more' : 'reported as not sent'}`);
      await commit(current.map(row => sameDelivery(entry, row) ? retry
        ? { ...row, state: 'queued', owner: null, offeredAt: undefined, sendAuthorizedAt: undefined, requiresAuthorization: undefined,
          deliveryText: undefined, error: undefined, notTakenRetries: (row.notTakenRetries ?? 0) + 1 }
        : { ...row, state: 'failed', error: NOT_TAKEN_FAILED } : row));
      if (!retry) {
        decisionWaiters.get(id)?.reject(new Error('goal_browser_send_failed: ' + NOT_TAKEN_FAILED));
        decisionWaiters.delete(id);
      }
      return true;
    }
    if (entry.recovery && entry.requiresAuthorization === true && entry.sendAuthorizedAt === undefined) {
      // Said once per reason, not once per attempt: the pickup schedule can hand the same ticket to
      // the same page every few seconds, and an unbounded log is its own kind of silence.
      const told = detail ? `${error} (${detail})` : error;
      if (recoveryReleaseTold.get(entry.id) !== told) {
        recoveryReleaseTold.set(entry.id, told);
        if (recoveryReleaseTold.size > 200) for (const old of [...recoveryReleaseTold.keys()].slice(0, 50)) recoveryReleaseTold.delete(old);
        logWarn(`input ${entry.id}: the browser could not send this recovery message — ${told.slice(0, 200)}`);
      }
      const now = Date.now();
      const since = entry.recovery.withdrawnSince ?? now;
      await commit(current.map(row => row === entry
        ? { ...releaseRecoveryClaim(row, error), recovery: { ...releaseRecoveryClaim(row, error).recovery!, withdrawnSince: since } } : row));
      return true;
    }
    // The document reports this only while its native Send has never been attempted.
    // A final can arrive after authorization and veto that click. Retain the spent
    // claim, but do not let an unsent Continue consume the final's Goal/Loop decision.
    if (entry.recovery && entry.requiresAuthorization === true && error === 'After-turn pickup was withdrawn before Send.') {
      await commit(current.map(row => row === entry
        ? { ...row, state: 'failed', completedTurnId: undefined, error } : row));
      return true;
    }
    // A generic transport failure supplies no proof that native Send was skipped.
    if (entry.requiresAuthorization === true && entry.sendAuthorizedAt !== undefined) return false;
    const pickupCancelled = !!(entry.silenceBoundary || entry.completedTurnId) && entry.requiresAuthorization === true &&
      entry.sendAuthorizedAt === undefined && error === 'After-turn pickup was withdrawn before Send.';
    // Losing a document before Send does not lose a still-valid refresh ticket.
    // Real work revokes its source proof independently and must earn a new window.
    const preserveBoundary = pickupCancelled && await eligibleStageEnd(entry) === entry.completedTurnId;
    await commit(current.map((row) => sameDelivery(entry, row) ? pickupCancelled
      ? withoutSilenceClaim(row, row === entry && preserveBoundary)
      : { ...row, state: entry.companionInputId ? 'cancelled' : 'failed', error: error.slice(0, 200) } : row));
    decisionWaiters.get(id)?.reject(new Error('goal_browser_send_failed: ' + error.slice(0, 200)));
    decisionWaiters.delete(id);
    return true;
  });
}

/**
 * Ends every message still waiting for a chat that Gemini says it deleted.
 *
 * Measured 2026-10-11: opening a deleted chat sends the tab to Gemini's home page, and a
 * message for it waited in the queue with no status; one already claimed failed as "Requested
 * model or reasoning could not be confirmed". Nothing can be delivered into that chat any more,
 * so each one fails with the real reason instead of reopening it. Sent messages are untouched.
 */
export function failInputsForDeletedConversation(conversationId: string): Promise<number> {
  return serial(async () => {
    const current = await load();
    const ended = new Set<string>();
    for (const row of current) {
      if (row.state !== 'queued' && row.state !== 'browser') continue;
      let destination = row.conversationId;
      if (!destination) { try { destination = await target(row); } catch { destination = null; } }
      if (destination === conversationId) ended.add(row.id);
    }
    if (!ended.size) return 0;
    await commit(current.map(row => ended.has(row.id) ? { ...row, state: 'failed', owner: null, error: CONVERSATION_DELETED } : row));
    for (const id of ended) {
      decisionWaiters.get(id)?.reject(new Error('goal_browser_send_failed: ' + CONVERSATION_DELETED));
      decisionWaiters.delete(id);
    }
    return ended.size;
  });
}

// The browser is an alternative decision transport, using this same exclusive outbox.
// A timeout cancels authority; late answers cannot become messages in the source chat.
const decisionWaiters = new Map<string, { resolve: (text: string) => void; reject: (reason: unknown) => void; publish?: (text: string) => void }>();
/** Presentation only, fenced by the same exact decision claim as its eventual answer. */
export async function publishBrowserDecision(id: string, owner: string, conversationId: string | null, text: string): Promise<boolean> {
  if (text.length > 8000) return false;
  const entry = (await load()).find(row => row.id === id && row.owner === owner && row.purpose === 'decision' &&
    row.conversationId === conversationId && ['browser', 'decision'].includes(row.state));
  const waiter = decisionWaiters.get(id);
  if (!entry || !waiter) return false;
  waiter.publish?.(text); return true;
}
export async function requestBrowserDecision(text: string, signal: AbortSignal, options: {
  lifetime?: 'temporary-planner';
  sourceSessionId?: string; conversationId?: string | null; model?: string | null;
  reasoningEffort?: InputArgs['reasoningEffort'] | null;
  publish?: (text: string) => void;
  /** Gemini took the prompt (exact receipt) and it ended without an answer. */
  onSentUnanswered?: () => void;
} = {}): Promise<string> {
  if (!text.trim() || text.length > MAX_BROWSER_MESSAGE_CHARS) throw new Error('goal_context_too_large');
  signal.throwIfAborted();
  const id = randomUUID();
  let resolveAnswer!: (text: string) => void;
  let rejectAnswer!: (reason: unknown) => void;
  const answer = new Promise<string>((resolve, reject) => { resolveAnswer = resolve; rejectAnswer = reject; });
  void answer.catch(() => undefined);
  decisionWaiters.set(id, { resolve: resolveAnswer, reject: rejectAnswer, publish: options.publish });
  const cancel = () => {
    decisionWaiters.delete(id);
    rejectAnswer(new Error('goal_browser_cancelled'));
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const queued = await serial(async () => {
      signal.throwIfAborted();
      const current = await load();
      if (current.filter((row) => row.purpose === 'decision' && ['queued', 'browser', 'decision'].includes(row.state)).length >= 4) throw new Error('goal_browser_busy');
      if (options.sourceSessionId && current.some(row => row.decisionSourceSessionId === options.sourceSessionId && !terminal(row))) throw new Error('goal_browser_busy');
      // Only a helper cancelled before any receipt is ambiguous: it may or may not have reached a
      // chat nobody can name, so a second one could duplicate it. A confirmed Temporary Chat send
      // keeps no conversation id and is not ambiguous; refusing its retry stopped every Goal whose
      // helper answer was lost (2026-10-02) with "could not confirm" about a confirmed prompt.
      // A helper the app itself cancelled (a newer turn superseded it, Goal or Loop was switched off,
      // the request timed out) never blocks the next one: at worst its old Temporary Chat answers a
      // planning prompt nobody reads (user decision 2026-10-09). Only a person's cancellation pauses.
      if (options.sourceSessionId && !options.conversationId && current.some(row => row.decisionSourceSessionId === options.sourceSessionId &&
          row.state === 'cancelled' && row.cancelledByUser === true && !row.conversationId && row.deliveredAt === undefined)) {
        throw new Error('goal_browser_send_unconfirmed');
      }
      const entry = entrySchema.parse({ id, sessionId: null, text, mode: 'after-turn', dueAt: Date.now(),
        // null means Gemini's current selection; only an omitted value gets the historical default.
        model: options.model === undefined ? DEFAULT_HELPER_CHAT_MODEL : options.model,
        reasoningEffort: options.reasoningEffort === undefined ? 'high' : options.reasoningEffort,
        decisionSourceSessionId: options.sourceSessionId, lifetime: options.lifetime, purpose: 'decision', state: 'queued', owner: null,
        createdAt: Date.now(), conversationId: options.conversationId ?? null });
      await commit(append(current, entry));
      return entry;
    });
    signal.throwIfAborted();
    await deliveryHooks?.wakeDecision?.(queued, signal);
    signal.throwIfAborted();
    return await answer;
  } finally {
    decisionWaiters.delete(id);
    signal.removeEventListener('abort', cancel);
    // Catch an abort that raced enqueue before the answer was awaited.
    void answer.catch(() => undefined);
    let sentUnanswered = false;
    await serial(async () => {
      const current = await load();
      sentUnanswered = current.some(row => row.id === id && row.state === 'decision');
      if (current.some((row) => row.id === id && !terminal(row))) {
        await commit(current.map((row) => row.id === id && !terminal(row) ? { ...row, state: 'cancelled' } : row));
      }
    });
    if (sentUnanswered) options.onSentUnanswered?.();
  }
}
export function completeBrowserDecision(id: string, owner: string, response: string, conversationId?: string | null): Promise<boolean> {
  return serial(async () => {
    if (!response.trim() || response.length > 16000) return false;
    const current = await load();
    if (current.some((entry) => entry.id === id && entry.owner === owner && entry.purpose === 'decision' && entry.state === 'sent' && entry.response === response)) return true;
    if (!decisionWaiters.has(id)) return false;
    const row = current.find((entry) => entry.id === id && entry.owner === owner && entry.purpose === 'decision' && ['browser', 'decision'].includes(entry.state));
    if (!row) return false;
    if (conversationId && row.conversationId && conversationId !== row.conversationId) return false;
    await commit(current.map((entry) => entry === row ? { ...entry, conversationId: conversationId ?? row.conversationId, state: 'sent', response } : entry));
    const waiter = decisionWaiters.get(id);
    if (!waiter) await commit((await load()).map((entry) => entry.id === id ? { ...entry, state: 'cancelled', response: undefined } : entry));
    waiter?.resolve(response);
    return !!waiter;
  });
}

/** The outbox's exact native-send receipt survives losing the helper document.
 * Collect through the existing completion transaction when the recorder carries that
 * user's final answer. This grants no new browser claim and never resubmits a prompt.
 */
export async function collectRecordedBrowserDecision(conversationId: string): Promise<void> {
  const pending = (await listInputs()).filter(row => row.purpose === 'decision' && row.state === 'decision' &&
    row.conversationId === conversationId && row.messageId && row.owner && decisionWaiters.has(row.id));
  if (pending.length !== 1 || isChatBlocked(conversationId) || await conversationWasSuperseded(conversationId)) return;
  const row = pending[0]!;
  const session = await findSessionByConversation(conversationId, { requireUnique: true });
  if (!session || (row.deliveredSessionId && session.id !== row.deliveredSessionId)) return;
  const events = await readRecentEvents(session.id, 32, { kinds: ['user_message', 'assistant_message'], maxBytes: 1_048_576 });
  const user = events.findLastIndex(event => event.kind === 'user_message');
  const prompt = events[user];
  const final = events.at(-1);
  if (user < 0 || prompt?.kind !== 'user_message' || prompt.messageId !== row.messageId ||
      final?.kind !== 'assistant_message' || !final.final || final.state !== 'final' || !final.messageId ||
      final.message.truncated || final.message.text.length > 16000) return;
  await completeBrowserDecision(row.id, row.owner!, final.message.text, conversationId);
}
