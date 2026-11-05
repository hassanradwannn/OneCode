/** OneCode-owned API turns: durable Send receipt, bounded model loop and no browser. */
import { randomUUID } from "node:crypto";
import { setTimeout as wait } from 'node:timers/promises';
import { getConfig } from "../config.js";
import { readDurable, writeDurableNow } from "../durable.js";
import { appendEvent, getSession, readLatestUserMessage, upsertMessageEvent } from "../session/store.js";
import { acknowledgeOpenRouterInput, claimOpenRouterInput, failBrowserInput, noteInputStartupError, noteApiInputRecovery, listInputs, type InputEntry } from "../session/input.js";
import { notifyChanged } from "../session/recorder.js";
import { ApiError, type ApiMessage, type ApiModel, type ApiToolCall } from "./types.js";
import { apiProvider, apiInputOwner } from "./providers.js";
import { prepareSessionPrompt, prepareSkillFollowup } from "../session/prompt.js";
import { currentApiTurn, apiTools, type OwnedTurn } from "./tools.js";
import { acknowledgeApiWorker, finishApiWorker } from "./workers.js";
import { agentInfoForOwnedConversation, onSwarmEnd, failAgent, persistCriticalSwarmNow } from "../agents.js";
import { apiTurns as controllers, type ActiveApiTurn } from './activity.js';
import { generateApiTopicTitle, stopApiTitles } from './title.js';
import { apiRetryDelay, apiFailureDescription, API_RETRY_LIMIT } from './recovery.js';
import { apiOutputBudget } from './budget.js';
import { ApiRefusalWatch } from './refusals.js';
import type { OutputPublication } from '../codex/unified-exec.js';
import { logInfo } from '../logger.js';
export { apiTurnStatus } from './activity.js';

const MAX_ITERATIONS = 1000;
const MAX_CALLS = 3000;
const MAX_HISTORY_MESSAGES = 2000;
const MAX_HISTORY_BYTES = 32 * 1024 * 1024;
// A normal terminal result already has a 10K-token native presentation budget. Carry
// that complete rendering plus recovery pages instead of silently cutting it to 12K chars.
const MAX_TOOL_RESULT_CHARS = 64_000;
const SYSTEM = "You are an assistant in OneCode. The tools supplied with this request are available on the first user message, not only on follow-ups. For requested local work, use the provided tool functions rather than claiming you cannot access the approved workspace or can only draft a mockup. If no relevant tool is actually supplied or a call is refused, say so without inventing work. Tool calls are requests to OneCode, never executed by the model provider. Respect refused permissions and do not invent tool results, completed operations, receipts, or user authorizations. Unknown tool outcomes are not permission to repeat a mutation. For build, edit, inspection or repair requests, inspect the actual workspace or saved artifact with tools, then carry out the requested work. A code example in prose is not a created or changed file. Resolve the current project and approved roots before choosing a working directory; never assume an index.html exists. EXEC_RESULTS_UNREAD means completed command output must be collected, not that command permission was revoked. Following tool responses include bounded retained pages; read them and use write_stdin on the listed exact owned process IDs. Do not issue PING loops or ask the user to reset or discard pending results. A live command is separate from completed results. When an owned test is hung and stopping it is appropriate, write_stdin with chars set to the Ctrl-C character can interrupt it without launching another exec command. Never kill an arbitrary OS process based only on a port or a guessed PID. Complete requested verification and cleanup before handing work back; distinguish an intentional server from an unfinished test. Give brief public progress updates at useful milestones and report only work supported by tool results. Answer clearly once work is verified.";

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

function toolOutput(result: { content: Array<{ type: string; text?: string }>; isError?: boolean }): { text: string; clipped: boolean } {
  const pieces = result.content.map(part => part.type === "text" ? part.text ?? "" :
    "[Non-text tool output recorded in OneCode; see session artifact or media]");
  const text = pieces.join("\n");
  const clipped = text.length > MAX_TOOL_RESULT_CHARS ? text.slice(0, MAX_TOOL_RESULT_CHARS) +
    "\n[Tool response shortened for model context; full local record retained]" : text;
  return { text: result.isError ? "TOOL_ERROR: " + clipped : clipped, clipped: text.length > MAX_TOOL_RESULT_CHARS };
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
  const startedAt = Date.now();
  const active: ActiveApiTurn = { sessionId: entry.sessionId, turnId: null, controller, deliveryPending: true,
    activity: { phase: 'catalog', inputId: entry.id, since: startedAt } };
  controllers.set(entry.id, active);
  notifyChanged(entry.sessionId);
  const dropWorkerStop = entry.apiWorker ? onSwarmEnd((_reason, _retired, runId) => {
    if (runId === entry.apiWorker!.runId) controller.abort(new Error('Worker family ended'));
  }) : null;
  let admitted = false, accepted = false;
  let networkAttempted = false;
  let conversationId: string | null = null;
  let turnId: string | null = null;
  let painting = Promise.resolve();
  let paintTimer: ReturnType<typeof setTimeout> | null = null;
  let displayed = '', answerId = '', modelId = '';
  let ownedThread: Thread | null = null;
  let responseSaved = false;
  let retryCount = 0;
  const publications = new Set<OutputPublication>();
  const clearPaintTimer = () => { if (paintTimer) clearTimeout(paintTimer); paintTimer = null; };
  try {
    const provider = entry.chatProvider && apiProvider(entry.chatProvider);
    if (!provider) throw new ApiError("API_PROVIDER_UNAVAILABLE");

    if (!getConfig().sessions.record) throw new ApiError("SESSION_RECORDING_REQUIRED");
    let models: ApiModel[];
    for (let attempt = 0; ; attempt++) {
      controller.signal.throwIfAborted();
      try { models = await provider.models(controller.signal); break; }
      catch (error) {
        controller.signal.throwIfAborted();
        const delay = apiRetryDelay(error, attempt);
        if (delay === null) throw error;
        retryCount = attempt + 1;
        active.activity = { phase: 'recovering', inputId: entry.id, since: Date.now(), attempt: retryCount,
          retryAt: Date.now() + delay, reason: apiFailureDescription(error) };
        notifyChanged(entry.sessionId);
        await wait(delay, undefined, { signal: controller.signal });
      }
    }
    retryCount = 0;
    await noteInputStartupError(entry.id, null);
    const preparedAt = Date.now();
    active.activity = { phase: 'preparing', inputId: entry.id, since: preparedAt };
    notifyChanged(entry.sessionId);
    logInfo(`api timing input=${entry.id} queue_wait_ms=${Math.max(0, startedAt - entry.createdAt)} catalog_ms=${preparedAt - startedAt}`);
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
    let desiredOutput = 65_536, truncatedRounds = 0;
    const refusals = new ApiRefusalWatch();
    const system = SYSTEM + "\n" + provider.modelInstruction(model.id);
    const prompt = entry.apiWorker ? entry.deliveryText ?? entry.text : thread.messages.length
      ? await prepareSkillFollowup(entry.text, entry.text, undefined, { sessionId: entry.sessionId, chatProvider: provider.id })
      : await prepareSessionPrompt(entry.text, { sessionId: entry.sessionId, chatProvider: provider.id, autoSkills: entry.autoSkills });
    const messages: ApiMessage[] = [...thread.messages, { role: "user", content: prompt }];
    if (entry.steerTurnId) messages[messages.length - 1] = { role: 'user', content:
      'The user supplied this direction during the ongoing task. Continue the existing objective with this update; preserve completed work, running commands and workers. Use the saved tool results and process IDs. Do not restart the task or repeat earlier actions.\n\n' + prompt };
    apiOutputBudget(model, [{ role: 'system', content: system }, ...messages], declarations, desiredOutput);
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
      active.deliveryPending = false;
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
      let preparationBeganAt = round === 0 ? preparedAt : Date.now();
      roundId = round;
      if (accepted && await yieldToDirection()) return;
      if (round > 0) { displayed = ''; answerId = randomUUID(); paintedAt = 0; responseSaved = false; }
      active.activity = { phase: 'preparing', inputId: entry.id, since: preparationBeganAt }; notifyChanged(turn.sessionId);
      if (round > 0 && !await currentApiTurn(turn)) throw new ApiError("API_TURN_NOT_CURRENT");
      declarations = model.supportsTools ? tools.declarations : [];
      const requestMessages: ApiMessage[] = [{ role: "system", content: system },
        ...(round === 0 ? messages : thread.messages)];
      const { output, maximum } = apiOutputBudget(model, requestMessages, declarations, desiredOutput);
      let dispatchedAt = 0;
      const complete = () => provider.complete({ model: model.id, sessionId: turn.conversationId,
        messages: requestMessages, tools: declarations, maxCompletionTokens: output, signal: controller.signal,
        reasoningEffort: reasoning, onAccepted: async () => {
          if (dispatchedAt) logInfo(`api timing input=${entry.id} round=${round} header_wait_ms=${Date.now() - dispatchedAt}`);
          await firstAccepted(); active.activity = { phase: 'responding', since: Date.now() }; notifyChanged(turn.sessionId);
        }, onText: paint,
        onDispatch: requestBytes => {
          networkAttempted = true;
          dispatchedAt = Date.now();
          active.activity = { phase: 'requesting', inputId: entry.id, since: dispatchedAt, requestBytes };
          logInfo(`api timing input=${entry.id} round=${round} preparation_ms=${dispatchedAt - preparationBeganAt} request_bytes=${requestBytes}`);
          notifyChanged(turn.sessionId);
        },
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
          active.activity = { phase: 'recovering', inputId: entry.id, since: Date.now(), attempt: attempt + 1, retryAt, reason };
          // A pre-header failure has no Send ACK yet. Keep its durable input queued/claimed
          // with a truthful startup notice rather than fabricating a turn receipt.
          const notice = `${reason} Retrying model step ${attempt + 1}/${API_RETRY_LIMIT} in ${Math.ceil(delay / 1000)}s. Saved tool results and running tasks are retained.`;
          if (accepted) await recoveryNotice(notice);
          else await noteApiInputRecovery(entry.id, apiInputOwner(provider.id), notice);
          await wait(delay, undefined, { signal: controller.signal });
          controller.signal.throwIfAborted();
          if (accepted && await yieldToDirection()) return;
          preparationBeganAt = Date.now();
          active.activity = { phase: 'preparing', inputId: entry.id, since: preparationBeganAt }; notifyChanged(turn.sessionId);
        }
      }
      if (retried && accepted) await recoveryNotice('API connection recovered. Continuing the same task from saved results.');
      if (!accepted || !await currentApiTurn(turn)) throw new ApiError("API_TURN_NOT_CURRENT");
      // A validated response proves that this exact model request received its full tool
      // context. A later exact owner call can acknowledge those output pages in the kernel.
      for (const receipt of publications) receipt.completedAt = Date.now();
      publications.clear();
      const resultContent = response.content;
      if (resultContent && !displayed.endsWith(resultContent)) {
        // Streaming already painted these deltas; non-streaming and post-tool prose may be new.
        if (!displayed.endsWith(resultContent)) paint(resultContent);
      }
      clearPaintTimer();
      await painting;
      if (response.finishReason === 'length') {
        if (displayed || resultContent) {
          await upsertMessageEvent(turn.sessionId, assistantRow(displayed || resultContent, answerId, messageId, turn.turnId, model.id, false));
          thread.messages.push({ role: 'assistant', content: displayed || resultContent });
        }
        // Truncated reasoning signatures and function arguments are not complete protocol
        // items. Continue from safe public text and durable tool results, never dispatch them.
        thread.messages.push({ role: 'system', content: 'OneCode runtime continuation: the previous response reached its output-token limit. No truncated tool proposal was executed. Continue the existing task from saved tool results and running process IDs. Take the next small concrete step; do not restart or repeat completed actions.' });
        responseSaved = true; await saveThread(thread);
        if (++truncatedRounds > 3) throw new ApiError('OUTPUT_RECOVERY_LIMIT');
        desiredOutput = Math.min(maximum, Math.max(output + 1, output * 2));
        await recoveryNotice(`Response output limit reached. Continuing the same task automatically (${truncatedRounds}/3); requesting up to ${desiredOutput} output tokens within the model/context limit. Incomplete tool proposals were not executed.`);
        continue;
      }
      truncatedRounds = 0;
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
        const publication: OutputPublication = { completedAt: null, failed: false, maxTextBytes: MAX_TOOL_RESULT_CHARS - 64 };
        publications.add(publication);
        const result = await tools.invoke(call.function.name, argumentsJson, publication);
        invocations += 1;
        const schema = result.isError && JSON.stringify(result.content).includes('INVALID_ARGUMENTS:')
          ? tools.declarations.find(tool => tool.function.name === call.function.name)?.function.parameters : null;
        const rendered = toolOutput({ ...result, content: [...result.content,
          ...(schema ? [{ type: 'text', text: '\nExact current input schema for ' + call.function.name + ': ' + JSON.stringify(schema) }] : [])] });
        if (rendered.clipped) { publication.failed = true; publications.delete(publication); }
        const repeated = refusals.observe(rendered.text, round);
        thread.messages.push({ role: "tool", tool_call_id: call.id, content: rendered.text + repeated.guidance });
        await saveThread(thread);
        if (repeated.stalled) throw new ApiError('EXEC_RECOVERY_STALLED');
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
    if (admitted && !accepted) await failBrowserInput(entry.id, apiInputOwner(entry.chatProvider ?? "openrouter"),
      (networkAttempted ? 'API dispatch was not confirmed. ' : 'Message was not sent. ') + description).catch(() => undefined);
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
    // A result never included in a validated model request must be eligible for re-offer.
    for (const receipt of publications) receipt.failed = true;
    clearPaintTimer();
    dropWorkerStop?.();
    if (controllers.get(entry.id) === active) controllers.delete(entry.id);
  }
}
