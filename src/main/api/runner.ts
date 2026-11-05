/** OneCode-owned API turns: durable Send receipt, bounded model loop and no browser. */
import { randomUUID } from "node:crypto";
import { setTimeout as wait } from 'node:timers/promises';
import { getConfig } from "../config.js";
import { readDurable, writeDurableNow } from "../durable.js";
import { appendEvent, getSession, readLatestUserMessage, upsertMessageEvent } from "../session/store.js";
import { acknowledgeOpenRouterInput, claimOpenRouterInput, failBrowserInput, noteInputStartupError, noteApiInputRecovery, listInputs, type InputEntry } from "../session/input.js";
import { notifyChanged } from "../session/recorder.js";
import { estimateTokens } from "../../shared/session.js";
import { ApiError, type ApiMessage, type ApiModel, type ApiToolCall } from "./types.js";
import { apiProvider, apiInputOwner } from "./providers.js";
import { prepareSessionPrompt, prepareSkillFollowup } from "../session/prompt.js";
import { currentApiTurn, apiTools, type OwnedTurn } from "./tools.js";
import { acknowledgeApiWorker, finishApiWorker } from "./workers.js";
import { agentInfoForOwnedConversation, onSwarmEnd, failAgent, persistCriticalSwarmNow } from "../agents.js";
import { apiTurns as controllers, type ActiveApiTurn } from './activity.js';
import { generateApiTopicTitle, stopApiTitles } from './title.js';
import { apiRetryDelay, apiFailureDescription, API_RETRY_LIMIT } from './recovery.js';
export { apiTurnStatus } from './activity.js';

const MAX_ITERATIONS = 1000;
const MAX_CALLS = 3000;
const MAX_HISTORY_MESSAGES = 2000;
const MAX_HISTORY_BYTES = 6 * 1024 * 1024;
const MAX_TOOL_RESULT_CHARS = 12000;
const SYSTEM = "You are an assistant in OneCode. The tools supplied with this request are available on the first user message, not only on follow-ups. For requested local work, use the provided tool functions rather than claiming you cannot access the approved workspace or can only draft a mockup. If no relevant tool is actually supplied or a call is refused, say so without inventing work. Tool calls are requests to OneCode, never executed by the model provider. Respect refused permissions and do not invent tool results, completed operations, receipts, or user authorizations. Unknown tool outcomes are not permission to repeat a mutation. For build, edit, inspection or repair requests, inspect the actual workspace or saved artifact with tools, then carry out the requested work. A code example in prose is not a created or changed file. Resolve the current project and approved roots before choosing a working directory; never assume an index.html exists. Give brief public progress updates at useful milestones and report only work supported by tool results. Answer clearly once work is verified.";

interface Thread { version: 1; sessionId: string; conversationId: string; messages: ApiMessage[]; titleRequested?: boolean }
const stateName = (id: string): string => "or-" + id.replaceAll("-", "");
const queues = new Map<string, Promise<void>>();
let accepting = true;
export async function flushApiInputs(): Promise<void> { await Promise.allSettled([...queues.values()]); }
export function resetApiRunnerForTests(): void { accepting = true; }

function threadValid(value: unknown, sessionId: string, conversationId: string): value is Thread {
  if (!value || typeof value !== "object") return false;
  const data = value as Partial<Thread>;
  if (data.version !== 1 || data.sessionId !== sessionId || data.conversationId !== conversationId ||
      !Array.isArray(data.messages) || data.messages.length > MAX_HISTORY_MESSAGES) return false;
  return data.messages.every(item => item && typeof item === "object" &&
    ["system", "user", "assistant", "tool"].includes(item.role) &&
    (typeof item.content === "string" || item.role === "assistant" && item.content === null));
}

async function loadThread(sessionId: string, conversationId: string): Promise<Thread> {
  const existing = await readDurable<unknown>(stateName(sessionId), { strict: true });
  if (existing === null) return { version: 1, sessionId, conversationId, messages: [] };
  if (!threadValid(existing, sessionId, conversationId)) throw new ApiError("THREAD_STORAGE_INVALID");
  // A stopped/crashed loop may have saved a tool request before its response.
  // Preserve that exact call as an unknown outcome so the next user message is
  // protocol-valid without silently executing or repeating the earlier action.
  const pending = new Set<string>();
  const repaired: ApiMessage[] = [];
  const closePending = () => {
    for (const id of pending) repaired.push({ role: 'tool', tool_call_id: id,
      content: 'PRIOR_TOOL_OUTCOME_UNAVAILABLE: The previous API turn was interrupted before this result was durably saved. Inspect local tool records; do not repeat an uncertain action.' });
    pending.clear();
  };
  for (const message of existing.messages) {
    if (message.role !== 'tool') closePending();
    repaired.push(message);
    if (message.role === 'assistant') for (const call of message.tool_calls ?? []) pending.add(call.id);
    if (message.role === 'tool') pending.delete(message.tool_call_id);
  }
  closePending();
  existing.messages = repaired;
  return existing;
}
async function saveThread(thread: Thread): Promise<void> {
  if (thread.messages.length > MAX_HISTORY_MESSAGES || Buffer.byteLength(JSON.stringify(thread)) > MAX_HISTORY_BYTES)
    throw new ApiError("THREAD_TOO_LARGE");
  await writeDurableNow(stateName(thread.sessionId), thread);
}

function budget(messages: ApiMessage[], model: ApiModel, tools: object[], output: number): void {
  const reserve = Math.max(256, output);
  const prompt = estimateTokens(SYSTEM) + estimateTokens(JSON.stringify(messages)) +
    estimateTokens(JSON.stringify(tools)) + 256;
  if (prompt + reserve > model.contextLength) throw new ApiError("CONTEXT_LIMIT");
}

function toolOutput(result: { content: Array<{ type: string; text?: string }>; isError?: boolean }): string {
  const pieces = result.content.map(part => part.type === "text" ? part.text ?? "" :
    "[Non-text tool output recorded in OneCode; see session artifact or media]");
  const text = pieces.join("\n");
  const clipped = text.length > MAX_TOOL_RESULT_CHARS ? text.slice(0, MAX_TOOL_RESULT_CHARS) +
    "\n[Tool response shortened for model context; full local record retained]" : text;
  return result.isError ? "TOOL_ERROR: " + clipped : clipped;
}

function assistantRow(text: string, id: string, replyTo: string, turnId: string, model: string, final: boolean) {
  return { kind: "assistant_message" as const, source: "app" as const, time: Date.now(),
    messageId: id, responseToQuestionId: replyTo, turnId, resolvedModel: model,
    state: final ? "final" as const : "streaming" as const, final,
    message: { text, chars: text.length, truncated: false } };
}

/** Stops the exact current API generation. A running tool may still settle its receipt. */
export function stopApiTurn(sessionId: string, expectedTurnId: string): boolean {
  for (const active of controllers.values()) {
    if (active.sessionId !== sessionId || active.turnId !== expectedTurnId || active.controller.signal.aborted) continue;
    active.controller.abort(new Error("User requested Stop"));
    return true;
  }
  return false;
}
export function cancelApiInput(inputId: string): boolean {
  const active = controllers.get(inputId);
  if (!active || active.controller.signal.aborted) return false;
  active.controller.abort(new Error("Input cancelled"));
  return true;
}

export function stopApiInputs(): void {
  accepting = false;
  stopApiTitles();
  for (const active of controllers.values()) active.controller.abort(new Error('The app is shutting down'));
}

/** A queue is per authoritative OneCode session, not per OpenRouter request/session_id. */
export function scheduleApiInput(entry: InputEntry): void {
  if (!accepting || !entry.sessionId || !entry.chatProvider || !apiProvider(entry.chatProvider)) return;
  const sessionId = entry.sessionId;
  const previous = queues.get(sessionId) ?? Promise.resolve();
  const work = previous.catch(() => undefined).then(async () => {
    const latest = (await listInputs()).find(row => row.id === entry.id);
    if (accepting && latest?.state === 'queued') await perform(latest);
  });
  queues.set(sessionId, work);
  void work.catch(() => undefined).finally(() => { if (queues.get(sessionId) === work) queues.delete(sessionId); });
}

/** Keep the running task alive. The durable direction is consumed at a model/tool boundary;
 * an HTTP response stream cannot accept extra input while it is being generated. */
export async function steerApiInput(entry: InputEntry): Promise<void> {
  scheduleApiInput(entry);
}

async function perform(entry: InputEntry): Promise<void> {
  if (!entry.sessionId || !entry.model) return;
  const controller = new AbortController();
  const active: ActiveApiTurn = { sessionId: entry.sessionId, turnId: null, controller, activity: { phase: 'requesting' } };
  controllers.set(entry.id, active);
  const dropWorkerStop = entry.apiWorker ? onSwarmEnd((_reason, _retired, runId) => {
    if (runId === entry.apiWorker!.runId) controller.abort(new Error('Worker family ended'));
  }) : null;
  let admitted = false, accepted = false;
  let conversationId: string | null = null;
  let turnId: string | null = null;
  let painting = Promise.resolve();
  let paintTimer: ReturnType<typeof setTimeout> | null = null;
  let displayed = '', answerId = '', modelId = '';
  let ownedThread: Thread | null = null;
  let responseSaved = false;
  let retryCount = 0;
  const clearPaintTimer = () => { if (paintTimer) clearTimeout(paintTimer); paintTimer = null; };
  try {
    const provider = entry.chatProvider && apiProvider(entry.chatProvider);
    if (!provider) throw new ApiError("API_PROVIDER_UNAVAILABLE");

    if (!getConfig().sessions.record) throw new ApiError("SESSION_RECORDING_REQUIRED");
    const models = await provider.models(controller.signal);
    const model = models.find(item => item.id === entry.model) ??
      (entry.model === provider.defaultModel.id ? provider.defaultModel : undefined);
    if (!model) throw new ApiError("MODEL_UNAVAILABLE");
    const session = await getSession(entry.sessionId);
    if (!session) throw new ApiError("SESSION_UNAVAILABLE");
    conversationId = session.conversationId ?? provider.id + ":" + randomUUID();
    const thread = await loadThread(entry.sessionId, conversationId); ownedThread = thread;
    const claimed = await claimOpenRouterInput(entry.id, conversationId);
    if (!claimed) return;
    admitted = true;
    const messageId = randomUUID(); answerId = randomUUID(); modelId = model.id;
    turnId = (provider.id === "openrouter" ? "or-" : "api-") + randomUUID(); active.turnId = turnId;
    const turn: OwnedTurn = { provider: provider.id, sessionId: entry.sessionId, conversationId, inputId: entry.id,
      messageId, turnId, signal: controller.signal };
    const tools = apiTools(turn);
    let declarations = model.supportsTools ? tools.declarations : [];
    if (model.supportsTools && declarations.length === 0)
      throw new ApiError("CORE_TOOLS_UNAVAILABLE");
    const reasoningEffort = entry.reasoningEffort;
    const reasoning = reasoningEffort === 'minimal' || reasoningEffort === 'low' ||
      reasoningEffort === 'medium' || reasoningEffort === 'high' || reasoningEffort === 'xhigh'
      ? reasoningEffort : undefined;
    if (reasoning && !model.supportedParameters.some(param => param === 'reasoning' || param === 'reasoning_effort'))
      throw new ApiError('MODEL_REASONING_UNAVAILABLE');
    // High-effort reasoning consumes completion tokens before visible prose or
    // tool calls. A hard 4096-token cap truncated legitimate long agent turns.
    // Retain a finite budget and respect the selected model's published ceiling.
    const output = Math.min(model.maxCompletionTokens ?? 16384, 16384,
      Math.max(512, Math.floor(model.contextLength * 0.55)));
    const system = SYSTEM + "\n" + provider.modelInstruction(model.id);
    const prompt = entry.apiWorker ? entry.deliveryText ?? entry.text : thread.messages.length
      ? await prepareSkillFollowup(entry.text, entry.text, undefined, { sessionId: entry.sessionId, chatProvider: provider.id })
      : await prepareSessionPrompt(entry.text, { sessionId: entry.sessionId, chatProvider: provider.id, autoSkills: entry.autoSkills });
    const messages: ApiMessage[] = [...thread.messages, { role: "user", content: prompt }];
    if (entry.steerTurnId) messages[messages.length - 1] = { role: 'user', content:
      'The user supplied this direction during the ongoing task. Continue the existing objective with this update; preserve completed work, running commands and workers. Use the saved tool results and process IDs. Do not restart the task or repeat earlier actions.\n\n' + prompt };
    const contextMessages: ApiMessage[] = [{ role: "system", content: system }, ...messages];
    budget(contextMessages, model, declarations, output);
    let invocations = 0, paintedAt = 0;
    const flushPaint = () => {
      clearPaintTimer();
      if (!accepted || controller.signal.aborted || !displayed) return;
      paintedAt = Date.now();
      const snapshot = displayed, snapshotId = answerId;
      painting = painting.then(() => upsertMessageEvent(turn.sessionId, assistantRow(snapshot, snapshotId, messageId, turnId!, model.id, false)))
        .then(() => notifyChanged(turn.sessionId));
      void painting.catch(error => controller.abort(error));
    };
    const paint = (addition: string) => {
      displayed += addition; active.activity = { phase: 'responding' };
      if (!accepted) return;
      if (Date.now() - paintedAt >= 180) flushPaint();
      else if (!paintTimer) paintTimer = setTimeout(flushPaint, 180 - (Date.now() - paintedAt));
    };
    const firstAccepted = async () => {
      if (accepted) return;
      controller.signal.throwIfAborted();
      if (!await acknowledgeOpenRouterInput(entry.id, conversationId!, messageId))
        throw new ApiError("INPUT_RECEIPT_REJECTED");
      await appendEvent(turn.sessionId, { kind: "turn_start", source: "app", time: Date.now(), turnId: turn.turnId });
      accepted = true;
      await acknowledgeApiWorker(entry);
      thread.messages = messages;
      await saveThread(thread);
      notifyChanged(turn.sessionId);
    };
    const pendingDirection = async () => (await listInputs()).some(row => row.sessionId === turn.sessionId &&
      row.conversationId === turn.conversationId && row.state === 'queued' && !row.owner &&
      row.steerReady && row.steerTurnId === turn.turnId && row.directTurn?.questionId === turn.messageId &&
      row.dueAt <= Date.now() && !row.cancelledByUser);
    const yieldToDirection = async () => {
      controller.signal.throwIfAborted();
      if (!await pendingDirection()) return false;
      clearPaintTimer(); await painting;
      if (displayed) {
        await upsertMessageEvent(turn.sessionId, assistantRow(displayed, answerId, messageId, turn.turnId, model.id, false));
        if (!responseSaved) {
          thread.messages.push({ role: 'assistant', content: displayed });
          await saveThread(thread);
          responseSaved = true;
        }
      }
      await appendEvent(turn.sessionId, { kind: 'turn_end', source: 'app', time: Date.now(),
        turnId: turn.turnId, outcome: 'interrupted', reason: 'steer', detail: 'Direction updated; task continues.' });
      notifyChanged(turn.sessionId);
      return true;
    };
    const recoveryNotice = async (text: string) => {
      await appendEvent(turn.sessionId, { kind: 'progress', source: 'app', time: Date.now(),
        turnId: turn.turnId, progressId: `api-recovery:${turn.turnId}:${roundId}`, message: { text, chars: text.length, truncated: false } });
      notifyChanged(turn.sessionId);
    };
    let roundId = 0;
    for (let round = 0; round < MAX_ITERATIONS; round += 1) {
      controller.signal.throwIfAborted();
      roundId = round;
      if (accepted && await yieldToDirection()) return;
      if (round > 0) { displayed = ''; answerId = randomUUID(); paintedAt = 0; responseSaved = false; }
      active.activity = { phase: 'requesting' }; notifyChanged(turn.sessionId);
      if (round > 0 && !await currentApiTurn(turn)) throw new ApiError("API_TURN_NOT_CURRENT");
      declarations = model.supportsTools ? tools.declarations : [];
      const requestMessages: ApiMessage[] = [{ role: "system", content: system },
        ...(round === 0 ? messages : thread.messages)];
      budget(requestMessages, model, declarations, output);
      const complete = () => provider.complete({ model: model.id, sessionId: turn.conversationId,
        messages: requestMessages, tools: declarations, maxCompletionTokens: output, signal: controller.signal,
        reasoningEffort: reasoning, onAccepted: firstAccepted, onText: paint,
        onToolCall: name => {
          if (!declarations.some(tool => tool.function.name === name) || controller.signal.aborted) return;
          active.activity = { phase: 'preparing-tool' }; notifyChanged(turn.sessionId);
        } });
      let response: Awaited<ReturnType<typeof complete>>;
      let retried = false;
      retryCount = 0;
      for (let attempt = 0; ; attempt++) {
        controller.signal.throwIfAborted();
        try { response = await complete(); break; }
        catch (error) {
          controller.signal.throwIfAborted();
          // Storage/receipt failures and tool execution never enter an inference retry.
          if (accepted && await yieldToDirection()) return;
          const delay = apiRetryDelay(error, attempt);
          if (delay === null) throw error;
          retried = true;
          retryCount = attempt + 1;
          clearPaintTimer(); await painting;
          if (accepted && displayed) await upsertMessageEvent(turn.sessionId,
            assistantRow(displayed, answerId, messageId, turn.turnId, model.id, false));
          displayed = ''; answerId = randomUUID(); paintedAt = 0;
          const reason = apiFailureDescription(error), retryAt = Date.now() + delay;
          active.activity = { phase: 'recovering', attempt: attempt + 1, retryAt, reason };
          // A pre-header failure has no Send ACK yet. Keep its durable input queued/claimed
          // with a truthful startup notice rather than fabricating a turn receipt.
          const notice = `${reason} Retrying model step ${attempt + 1}/${API_RETRY_LIMIT} in ${Math.ceil(delay / 1000)}s. Saved tool results and running tasks are retained.`;
          if (accepted) await recoveryNotice(notice);
          else await noteApiInputRecovery(entry.id, apiInputOwner(provider.id), notice);
          await wait(delay, undefined, { signal: controller.signal });
          controller.signal.throwIfAborted();
          if (accepted && await yieldToDirection()) return;
          active.activity = { phase: 'requesting' }; notifyChanged(turn.sessionId);
        }
      }
      if (retried && accepted) await recoveryNotice('API connection recovered. Continuing the same task from saved results.');
      if (!accepted || !await currentApiTurn(turn)) throw new ApiError("API_TURN_NOT_CURRENT");
      const resultContent = response.content;
      if (resultContent && !displayed.endsWith(resultContent)) {
        // Streaming already painted these deltas; non-streaming and post-tool prose may be new.
        if (!displayed.endsWith(resultContent)) paint(resultContent);
      }
      clearPaintTimer();
      await painting;
      const calls = response.toolCalls;
      if (calls.length && (displayed || resultContent)) {
        await upsertMessageEvent(turn.sessionId, assistantRow(displayed || resultContent, answerId, messageId, turn.turnId, response.model || model.id, false));
        notifyChanged(turn.sessionId);
      }
      thread.messages.push({ role: "assistant", content: resultContent || null,
        ...(response.reasoningDetails.length ? { reasoning_details: response.reasoningDetails } : {}),
        ...(calls.length ? { tool_calls: calls } : {}) });
      responseSaved = true;
      await saveThread(thread);
      const skipUndispatched = async (remaining: ApiToolCall[]) => {
        for (const call of remaining) thread.messages.push({ role: 'tool', tool_call_id: call.id,
          content: 'NOT_EXECUTED: The user supplied a new direction before this tool was dispatched. No action ran for this call.' });
        if (remaining.length) await saveThread(thread);
      };
      if (await pendingDirection()) {
        await skipUndispatched(calls);
        if (await yieldToDirection()) return;
        // A cancellation between the reads cannot turn the skipped calls into executable work.
        continue;
      }
      if (!calls.length) {
        await painting;
        await upsertMessageEvent(turn.sessionId, assistantRow(displayed || resultContent, answerId, messageId, turn.turnId, response.model || model.id, true));
        await appendEvent(turn.sessionId, { kind: "turn_end", source: "app", time: Date.now(),
          turnId: turn.turnId, outcome: "completed" });
        await finishApiWorker(entry, displayed || resultContent || "Worker completed without a text report.");
        notifyChanged(turn.sessionId);
        try {
          const summary = await getSession(turn.sessionId);
          if (!controller.signal.aborted && !thread.titleRequested && !entry.apiWorker && summary?.titleSource !== 'manual' && summary?.titleSource !== 'provider' &&
              (!summary?.origin || summary.origin.kind === 'desktop')) {
            thread.titleRequested = true; await saveThread(thread);
            const question = thread.messages.find(row => row.role === 'user')?.content ?? entry.text;
            generateApiTopicTitle(turn.sessionId, conversationId, question ?? entry.text, displayed || resultContent, provider, model);
          }
        } catch { /* Optional naming cannot turn completed task work into failure. */ }
        return;
      }
      if (calls.length > 16 || invocations + calls.length > MAX_CALLS) throw new ApiError("TOOL_LIMIT");
      if (!model.supportsTools) throw new ApiError("MODEL_TOOLS_UNAVAILABLE");
      for (const [index, call] of (calls as ApiToolCall[]).entries()) {
        controller.signal.throwIfAborted();
        if (await pendingDirection()) {
          await skipUndispatched(calls.slice(index));
          if (await yieldToDirection()) return;
          break;
        }
        if (!await currentApiTurn(turn)) throw new ApiError("API_TURN_NOT_CURRENT");
        const argumentsJson = JSON.parse(call.function.arguments) as unknown;
        active.activity = { phase: 'preparing-tool', tool: call.function.name };
        notifyChanged(turn.sessionId);
        const result = await tools.invoke(call.function.name, argumentsJson);
        invocations += 1;
        const schema = result.isError && JSON.stringify(result.content).includes('INVALID_ARGUMENTS:')
          ? tools.declarations.find(tool => tool.function.name === call.function.name)?.function.parameters : null;
        thread.messages.push({ role: "tool", tool_call_id: call.id, content: toolOutput(result) +
          (schema ? '\nExact current input schema for ' + call.function.name + ': ' + JSON.stringify(schema) : '') });
        await saveThread(thread);
        // An explicit worker finish ends its generation locally; no extra paid request or new tool.
        const worker = entry.apiWorker && agentInfoForOwnedConversation(conversationId);
        if (worker && ['sleeping', 'finished'].includes(worker.state)) {
          await painting;
          await upsertMessageEvent(turn.sessionId, assistantRow(worker.result || displayed || 'Worker reported completion.',
            answerId, messageId, turn.turnId, model.id, true));
          await appendEvent(turn.sessionId, { kind: 'turn_end', source: 'app', time: Date.now(), turnId: turn.turnId, outcome: 'completed' });
          notifyChanged(turn.sessionId);
          return;
        }
      }
    }
    throw new ApiError("ITERATION_LIMIT");
  } catch (error) {
    clearPaintTimer();
    await painting.catch(() => undefined);
    const code = error instanceof ApiError ? error.code : controller.signal.aborted ? "STOPPED" : "LOCAL_EXECUTION_FAILED";
    const description = apiFailureDescription(error) + (retryCount >= API_RETRY_LIMIT
      ? ` Automatic recovery exhausted after ${retryCount} retries. Saved results and running processes are retained.` : '');
    // Only the inference operation above is retryable. Never replay a local tool or storage write.
    if (!admitted && !controller.signal.aborted)
      await noteInputStartupError(entry.id, "Message queued. " + description).catch(() => undefined);
    if (admitted && !accepted) await failBrowserInput(entry.id, apiInputOwner(entry.chatProvider ?? "openrouter"), "API dispatch was not confirmed. " + description).catch(() => undefined);
    if (entry.apiWorker && !accepted) {
      failAgent(entry.apiWorker.agentId, 'API worker could not start (' + code + '). Inspect its saved input before assigning more work.',
        undefined, {}, entry.apiWorker.runId);
      await persistCriticalSwarmNow().catch(() => false);
    }
    if (accepted && turnId) {
      if (displayed && answerId && conversationId) {
        const question = await readLatestUserMessage(entry.sessionId).catch(() => null);
        if (question?.messageId) await upsertMessageEvent(entry.sessionId,
          assistantRow(displayed, answerId, question.messageId, turnId, modelId, false)).catch(() => undefined);
        if (ownedThread && !responseSaved) {
          ownedThread.messages.push({ role: 'assistant', content: displayed });
          await saveThread(ownedThread).catch(() => undefined);
        }
      }
      if (!controller.signal.aborted) await appendEvent(entry.sessionId, { kind: "chat_error", source: "app", time: Date.now(),
        turnId, message: { text: description, chars: description.length, truncated: false } }).catch(() => undefined);
      await appendEvent(entry.sessionId, { kind: "turn_end", source: "app", time: Date.now(),
        turnId, outcome: controller.signal.aborted ? "stopped" : "failed" }).catch(() => undefined);
      await finishApiWorker(entry, controller.signal.aborted ? 'Stopped by the user; work may be incomplete.'
        : 'API worker failed (' + code + '). Inspect saved outcomes before assigning more work.', controller.signal.aborted).catch(() => undefined);
      notifyChanged(entry.sessionId);
    }
  } finally {
    clearPaintTimer();
    dropWorkerStop?.();
    if (controllers.get(entry.id) === active) controllers.delete(entry.id);
  }
}
