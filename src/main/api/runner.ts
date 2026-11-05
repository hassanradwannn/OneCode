/** OneCode-owned API turns: durable Send receipt, bounded model loop and no browser. */
import { randomUUID } from "node:crypto";
import { getConfig } from "../config.js";
import { readDurable, writeDurableNow } from "../durable.js";
import { appendEvent, getSession, upsertMessageEvent } from "../session/store.js";
import { acknowledgeOpenRouterInput, claimOpenRouterInput, failBrowserInput, noteInputStartupError, type InputEntry } from "../session/input.js";
import { notifyChanged } from "../session/recorder.js";
import { estimateTokens } from "../../shared/session.js";
import { ApiError, type ApiMessage, type ApiModel, type ApiToolCall } from "./types.js";
import { apiProvider, apiInputOwner } from "./providers.js";
import { prepareSessionPrompt, prepareSkillFollowup } from "../session/prompt.js";
import { currentApiTurn, apiTools, type OwnedTurn } from "./tools.js";
import { acknowledgeApiWorker, finishApiWorker } from "./workers.js";
import { agentInfoForOwnedConversation, onSwarmEnd, failAgent, persistCriticalSwarmNow } from "../agents.js";

const MAX_ITERATIONS = 20;
const MAX_CALLS = 60;
const MAX_HISTORY_MESSAGES = 2000;
const MAX_HISTORY_BYTES = 6 * 1024 * 1024;
const MAX_TOOL_RESULT_CHARS = 12000;
const SYSTEM = "You are an assistant in OneCode. The tools supplied with this request are available on the first user message, not only on follow-ups. For requested local work, use the provided tool functions rather than claiming you cannot access the approved workspace or can only draft a mockup. If no relevant tool is actually supplied or a call is refused, say so without inventing work. Tool calls are requests to OneCode, never executed by the model provider. Respect refused permissions and do not invent tool results, completed operations, receipts, or user authorizations. Unknown tool outcomes are not permission to repeat a mutation. Answer clearly once work is verified.";

interface Thread { version: 1; sessionId: string; conversationId: string; messages: ApiMessage[] }
const stateName = (id: string): string => "or-" + id.replaceAll("-", "");
const controllers = new Map<string, { sessionId: string; turnId: string | null; controller: AbortController }>();
const queues = new Map<string, Promise<void>>();

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
export function apiTurnStatus(sessionId: string, turnId: string | null): 'running' | 'stopping' | null {
  if (!turnId) return null;
  const active = [...controllers.values()].find(item => item.sessionId === sessionId && item.turnId === turnId);
  return active ? active.controller.signal.aborted ? 'stopping' : 'running' : null;
}
export function cancelApiInput(inputId: string): boolean {
  const active = controllers.get(inputId);
  if (!active || active.controller.signal.aborted) return false;
  active.controller.abort(new Error("Input cancelled"));
  return true;
}

export function stopApiInputs(): void {
  for (const active of controllers.values()) active.controller.abort(new Error('The app is shutting down'));
}

/** A queue is per authoritative OneCode session, not per OpenRouter request/session_id. */
export function scheduleApiInput(entry: InputEntry): void {
  if (!entry.sessionId || !entry.chatProvider || !apiProvider(entry.chatProvider)) return;
  const sessionId = entry.sessionId;
  const previous = queues.get(sessionId) ?? Promise.resolve();
  const work = previous.catch(() => undefined).then(() => perform(entry));
  queues.set(sessionId, work);
  void work.catch(() => undefined).finally(() => { if (queues.get(sessionId) === work) queues.delete(sessionId); });
}

async function perform(entry: InputEntry): Promise<void> {
  if (!entry.sessionId || !entry.model) return;
  const controller = new AbortController();
  const active = { sessionId: entry.sessionId, turnId: null as string | null, controller };
  controllers.set(entry.id, active);
  const dropWorkerStop = entry.apiWorker ? onSwarmEnd((_reason, _retired, runId) => {
    if (runId === entry.apiWorker!.runId) controller.abort(new Error('Worker family ended'));
  }) : null;
  let admitted = false, accepted = false;
  let conversationId: string | null = null;
  let turnId: string | null = null;
  let painting = Promise.resolve();
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
    const thread = await loadThread(entry.sessionId, conversationId);
    const claimed = await claimOpenRouterInput(entry.id, conversationId);
    if (!claimed) return;
    admitted = true;
    const messageId = randomUUID(), answerId = randomUUID();
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
    const contextMessages: ApiMessage[] = [{ role: "system", content: system }, ...messages];
    budget(contextMessages, model, declarations, output);
    let displayed = "", invocations = 0;
    let paintedAt = 0;
    const paint = (addition: string) => {
      displayed += addition;
      if (!accepted || Date.now() - paintedAt < 180) return;
      paintedAt = Date.now();
      const snapshot = displayed;
      painting = painting.then(() => upsertMessageEvent(turn.sessionId, assistantRow(snapshot, answerId, messageId, turnId!, model.id, false)))
        .then(() => notifyChanged(turn.sessionId));
      void painting.catch(error => controller.abort(error));
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
    for (let round = 0; round < MAX_ITERATIONS; round += 1) {
      controller.signal.throwIfAborted();
      if (round > 0 && !await currentApiTurn(turn)) throw new ApiError("API_TURN_NOT_CURRENT");
      declarations = model.supportsTools ? tools.declarations : [];
      const requestMessages: ApiMessage[] = [{ role: "system", content: system },
        ...(round === 0 ? messages : thread.messages)];
      budget(requestMessages, model, declarations, output);
      const response = await provider.complete({ model: model.id, sessionId: conversationId,
        messages: requestMessages, tools: declarations, maxCompletionTokens: output, signal: controller.signal,
        reasoningEffort: reasoning, onAccepted: firstAccepted, onText: paint });
      if (!accepted || !await currentApiTurn(turn)) throw new ApiError("API_TURN_NOT_CURRENT");
      const resultContent = response.content;
      if (resultContent && !displayed.endsWith(resultContent)) {
        // Streaming already painted these deltas; non-streaming and post-tool prose may be new.
        if (!displayed.endsWith(resultContent)) paint(resultContent);
      }
      const calls = response.toolCalls;
      thread.messages.push({ role: "assistant", content: resultContent || null,
        ...(response.reasoningDetails.length ? { reasoning_details: response.reasoningDetails } : {}),
        ...(calls.length ? { tool_calls: calls } : {}) });
      await saveThread(thread);
      if (!calls.length) {
        await painting;
        await upsertMessageEvent(turn.sessionId, assistantRow(displayed || resultContent, answerId, messageId, turn.turnId, response.model || model.id, true));
        await appendEvent(turn.sessionId, { kind: "turn_end", source: "app", time: Date.now(),
          turnId: turn.turnId, outcome: "completed" });
        await finishApiWorker(entry, displayed || resultContent || "Worker completed without a text report.");
        notifyChanged(turn.sessionId);
        return;
      }
      if (calls.length > 16 || invocations + calls.length > MAX_CALLS) throw new ApiError("TOOL_LIMIT");
      if (!model.supportsTools) throw new ApiError("MODEL_TOOLS_UNAVAILABLE");
      for (const call of calls as ApiToolCall[]) {
        controller.signal.throwIfAborted();
        if (!await currentApiTurn(turn)) throw new ApiError("API_TURN_NOT_CURRENT");
        const argumentsJson = JSON.parse(call.function.arguments) as unknown;
        const result = await tools.invoke(call.function.name, argumentsJson);
        invocations += 1;
        thread.messages.push({ role: "tool", tool_call_id: call.id, content: toolOutput(result) });
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
    await painting.catch(() => undefined);
    const code = error instanceof ApiError ? error.code : controller.signal.aborted ? "STOPPED" : "API_REQUEST_FAILED";
    // A claimed operation may have reached OpenRouter or run local tools. Never retry it automatically.
    if (!admitted && !controller.signal.aborted)
      await noteInputStartupError(entry.id, "Message queued. OpenRouter unavailable (" + code + "). Review key, model or connection before retrying.").catch(() => undefined);
    if (admitted && !accepted) await failBrowserInput(entry.id, apiInputOwner(entry.chatProvider ?? "openrouter"), "OpenRouter dispatch was not confirmed (" + code + ").").catch(() => undefined);
    if (entry.apiWorker && !accepted) {
      failAgent(entry.apiWorker.agentId, 'API worker could not start (' + code + '). Inspect its saved input before assigning more work.',
        undefined, {}, entry.apiWorker.runId);
      await persistCriticalSwarmNow().catch(() => false);
    }
    if (accepted && turnId) {
      await appendEvent(entry.sessionId, { kind: "chat_error", source: "app", time: Date.now(),
        turnId, message: { text: code, chars: code.length, truncated: false } }).catch(() => undefined);
      await appendEvent(entry.sessionId, { kind: "turn_end", source: "app", time: Date.now(),
        turnId, outcome: controller.signal.aborted ? "stopped" : "failed" }).catch(() => undefined);
      await finishApiWorker(entry, controller.signal.aborted ? 'Stopped by the user; work may be incomplete.'
        : 'API worker failed (' + code + '). Inspect saved outcomes before assigning more work.', controller.signal.aborted).catch(() => undefined);
      notifyChanged(entry.sessionId);
    }
  } finally {
    dropWorkerStop?.();
    if (controllers.get(entry.id) === active) controllers.delete(entry.id);
  }
}
