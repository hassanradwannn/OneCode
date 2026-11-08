/** OneCode-owned API turns: durable Send receipt, bounded model loop and no browser. */
import { randomUUID } from "node:crypto";
import { setTimeout as wait } from 'node:timers/promises';
import { getConfig } from "../config.js";
import { readDurable, writeDurableNow } from "../durable.js";
import { appendEvent, getSession, readLatestUserMessage, upsertMessageEvent, conversationWasSuperseded } from "../session/store.js";
import { isChatBlocked } from '../session/blocked-chats.js';
import { acknowledgeOpenRouterInput, claimOpenRouterInput, failBrowserInput, noteInputStartupError, noteApiInputRecovery, listInputs, type InputEntry } from "../session/input.js";
import { notifyChanged } from "../session/recorder.js";
import { ApiError, type ApiMessage, type ApiModel, type ApiToolCall } from "./types.js";
import { apiProvider, apiInputOwner } from "./providers.js";
import { prepareSessionPrompt, prepareSkillFollowup } from "../session/prompt.js";
import { apiWebPreview } from './web-preview.js';
import { ARTIFACT_IMPORT_INSTRUCTIONS } from '../mcp/artifact-discovery.js';
import { currentApiTurn, apiTools, type OwnedTurn } from "./tools.js";
import { acknowledgeApiWorker, finishApiWorker } from "./workers.js";
import { agentInfoForOwnedConversation, onSwarmEnd, failAgent, persistCriticalSwarmNow } from "../agents.js";
import { apiTurns as controllers, type ActiveApiTurn } from './activity.js';
import { generateApiTopicTitle, stopApiTitles, apiTitleEligible, API_TITLE_VERSION } from './title.js';
import { apiRetryDelay, apiFailureDescription, API_RETRY_LIMIT } from './recovery.js';
import { apiOutputBudget } from './budget.js';
import { ApiRefusalWatch } from './refusals.js';
import type { OutputPublication } from '../codex/unified-exec.js';
import { logInfo } from '../logger.js';
import { compactApiContext, apiContextNeedsCompaction, contextTokens, type ApiThread } from './compaction.js';
import { apiCompactionProgress } from './compaction-progress.js';
import { apiUserMessage, assertApiInputSupported, validApiUserParts } from './attachments.js';
export { apiTurnStatus } from './activity.js';

const MAX_ITERATIONS = 1000;
const MAX_CALLS = 3000;
const MAX_HISTORY_MESSAGES = 2000;
const MAX_HISTORY_BYTES = 32 * 1024 * 1024;
// A normal terminal result already has a 10K-token native presentation budget. Carry
// that complete rendering plus recovery pages instead of silently cutting it to 12K chars.
const MAX_TOOL_RESULT_CHARS = 64_000;
const SYSTEM = "You are an assistant in OneCode. The tools supplied with this request are available on the first user message, not only on follow-ups. For requested local work, use the provided tool functions rather than claiming you cannot access the approved workspace or can only draft a mockup. If no relevant tool is actually supplied or a call is refused, say so without inventing work. Tool calls are requests to OneCode, never executed by the model provider. Respect refused permissions and do not invent tool results, completed operations, receipts, or user authorizations. Unknown tool outcomes are not permission to repeat a mutation. For build, edit, inspection or repair requests, inspect the actual workspace or saved artifact with tools, then carry out the requested work. A code example in prose is not a created or changed file. Resolve the current project and approved roots before choosing a working directory; never assume an index.html exists. EXEC_RESULTS_UNREAD means completed command output must be collected, not that command permission was revoked. Following tool responses include bounded retained pages; read them and use write_stdin on the listed exact owned process IDs. Do not issue PING loops or ask the user to reset or discard pending results. A live command is separate from completed results. When an owned test is hung and stopping it is appropriate, write_stdin with chars set to the Ctrl-C character can interrupt it without launching another exec command. Never kill an arbitrary OS process based only on a port or a guessed PID. Complete requested verification and cleanup before handing work back; distinguish an intentional server from an unfinished test. Give brief public progress updates at useful milestones and report only work supported by tool results. Answer clearly once work is verified.";

type Thread = ApiThread;
const stateName = (id: string): string => "or-" + id.replaceAll("-", "");
const queues = new Map<string, Promise<void>>();
let accepting = true;
let checkingCompaction = 0;
export async function flushApiInputs(): Promise<void> { await Promise.allSettled([...queues.values()]); }
export function hasActiveApiWork(): boolean { return checkingCompaction > 0 || queues.size > 0 || controllers.size > 0; }
export function resetApiRunnerForTests(): void { accepting = true; }

function threadValid(value: unknown, sessionId: string, conversationId: string): value is Thread {
  if (!value || typeof value !== "object") return false;
  const data = value as Partial<Thread>;
  if (data.version !== 1 || data.sessionId !== sessionId || data.conversationId !== conversationId ||
      !Array.isArray(data.messages) || data.messages.length > MAX_HISTORY_MESSAGES) return false;
  if(data.toolContextTokens!==undefined && (!Number.isSafeInteger(data.toolContextTokens)||data.toolContextTokens<0||data.toolContextTokens>4_000_000))return false;
  if([data.systemContextTokens,data.contextWindow].some(value=>value!==undefined && (!Number.isSafeInteger(value)||value<0||value>100_000_000)))return false;
  if(data.checkpoint && (!/^ac-[a-f0-9]{32}$/.test(data.checkpoint.archive)||!/^[a-f0-9]{64}$/.test(data.checkpoint.digest)||
      ![data.checkpoint.createdAt,data.checkpoint.beforeTokens,data.checkpoint.afterTokens].every(value=>Number.isFinite(value)&&value>=0)))return false;
  if(data.checkpoint && (data.checkpoint.workflowId!==undefined && (typeof data.checkpoint.workflowId!=='string'||!/^api-[a-f0-9-]{36}$/i.test(data.checkpoint.workflowId)) ||
      data.checkpoint.summary!==undefined && (typeof data.checkpoint.summary!=='string'||data.checkpoint.summary.length>12000) ||
      data.checkpoint.manual!==undefined && typeof data.checkpoint.manual!=='boolean' ||
      data.checkpoint.resumedAt!==undefined && (!Number.isSafeInteger(data.checkpoint.resumedAt)||data.checkpoint.resumedAt<0)))return false;
  return data.messages.every(item => item && typeof item === "object" &&
    ["system", "user", "assistant", "tool"].includes(item.role) &&
    (typeof item.content === "string" || item.role === "assistant" && item.content === null ||
      item.role === 'user' && validApiUserParts(item.content)));
}
/** Presentation derives the effective context from the existing saved thread,
 * independently of the full canonical transcript retained for history. */
export async function apiContextForSession(sessionId:string,conversationId:string):Promise<{tokens:number;limit:number}|null>{
  try{
    const thread=await readDurable<unknown>(stateName(sessionId),{strict:true});
    if(!threadValid(thread,sessionId,conversationId))return null;
    return {tokens:contextTokens(thread.messages)+(thread.toolContextTokens??0)+(thread.systemContextTokens??0),limit:thread.contextWindow??0};
  }catch{return null;}
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

/** Manual compaction joins the same session queue. A live task consumes its
 * request only at the next safe boundary; an idle/failed chat needs no new Send. */
export async function requestApiCompaction(sessionId: string, expectedConversation: string): Promise<void> {
  if (!accepting || isChatBlocked(expectedConversation)) throw new ApiError('API_TURN_NOT_CURRENT');
  checkingCompaction++;
  try {
    if (await conversationWasSuperseded(expectedConversation) || !accepting) throw new ApiError('API_TURN_NOT_CURRENT');
  } finally { checkingCompaction--; }
  const running=[...controllers.values()].find(item=>item.sessionId===sessionId);
  if(running){
    if(running.compactionOnly)return;
    running.compactionRequested=true;notifyChanged(sessionId);return;
  }
  const previous=queues.get(sessionId) ?? Promise.resolve();
  const work=previous.catch(()=>undefined).then(async()=>{
    const session=await getSession(sessionId);
    if(!accepting || !getConfig().sessions.record || !session || session.conversationId!==expectedConversation || isChatBlocked(expectedConversation))throw new ApiError('API_TURN_NOT_CURRENT');
    const provider=apiProvider('openrouter');if(!provider)throw new ApiError('API_PROVIDER_UNAVAILABLE');
    const controller=new AbortController(),key='compact:'+sessionId;
    const workflowId='api-'+randomUUID(),progress=apiCompactionProgress(sessionId,workflowId,true);
    const active:ActiveApiTurn={sessionId,turnId:null,controller,compactionOnly:true,activity:{phase:'compacting',since:Date.now()}};
    controllers.set(key,active);notifyChanged(sessionId);
    try{
      await progress('Preparing Compact & Resume.',{state:'archiving'});
      const input=(await listInputs()).filter(row=>row.sessionId===sessionId && row.chatProvider===provider.id && row.model).sort((a,b)=>b.createdAt-a.createdAt)[0];
      const selected=session.selectedModel?.conversationId===expectedConversation ? session.selectedModel.model : input?.model;
      const model=(await provider.models(controller.signal)).find(row=>row.id===selected) ?? (selected===provider.defaultModel.id?provider.defaultModel:undefined);
      if(!model)throw new ApiError('MODEL_UNAVAILABLE');
      const thread=await loadThread(sessionId,expectedConversation);
      const current=async()=>!controller.signal.aborted && !isChatBlocked(expectedConversation) &&
        !await conversationWasSuperseded(expectedConversation) && (await getSession(sessionId))?.conversationId===expectedConversation;
      const result=await compactApiContext({thread,provider,model,system:SYSTEM,tools:[],reserveTokens:thread.toolContextTokens,signal:controller.signal,current,
        progress:async(reason,update)=>{active.activity={phase:'compacting',since:Date.now(),reason};await progress(reason,update??{state:'summarizing'});}});
      if(result){
        if(!await current())throw new ApiError('API_TURN_NOT_CURRENT');
        await progress('Saving the reduced working context.',{state:'saving'});
        const checkpoint={...result.checkpoint,workflowId,summary:result.summary,manual:true};
        await saveThread({...thread,messages:result.messages,checkpoint,contextWindow:model.contextLength,
          systemContextTokens:contextTokens([{role:'system',content:SYSTEM}])-contextTokens([])});
        await progress('Summary saved — ready to continue in this chat.',{state:'saved',beforeTokens:checkpoint.beforeTokens,afterTokens:checkpoint.afterTokens,
          summary:{text:result.summary,chars:result.summary.length,truncated:false}});
      }else await progress('Context already fits; no history was replaced.',{state:'unchanged'});
    }catch(error){
      if(controller.signal.aborted){await progress('Compaction cancelled; original working context is retained.',{state:'cancelled'}).catch(()=>undefined);return;}
      await progress(apiFailureDescription(error),{state:'failed',reasonCode:error instanceof ApiError?error.code:'LOCAL_STORAGE_UNAVAILABLE'}).catch(()=>undefined);
      throw new Error(apiFailureDescription(error));
    }finally{if(controllers.get(key)===active)controllers.delete(key);notifyChanged(sessionId);}
  });
  queues.set(sessionId,work);
  try{await work;}finally{if(queues.get(sessionId)===work)queues.delete(sessionId);}
}
export function cancelApiCompaction(sessionId:string): void {
  const active=[...controllers.values()].find(item=>item.sessionId===sessionId);
  if(active?.compactionOnly)active.controller.abort(new Error('User cancelled context compaction'));
  else if(active)active.compactionRequested=false;
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
  const publicationMessages = new Map<OutputPublication, ApiMessage>();
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
    const preview = apiWebPreview(turn.sessionId);
    const tools = apiTools(turn, preview.observe);
    let declarations = model.supportsTools ? tools.declarations : [];
    if (model.supportsTools && declarations.length === 0)
      throw new ApiError("CORE_TOOLS_UNAVAILABLE");
    const reasoning = model.reasoningEfforts?.find(effort => effort === entry.reasoningEffort);
    if (entry.reasoningEffort && !reasoning) throw new ApiError('MODEL_REASONING_UNAVAILABLE');
    let desiredOutput = 65_536, truncatedRounds = 0;
    const refusals = new ApiRefusalWatch();
    const system = SYSTEM + "\nPresent interactive web deliverables in OneCode by default. " + ARTIFACT_IMPORT_INSTRUCTIONS +
      " Follow this workflow over older saved artifact guidance that asks you to copy a file into create. After compaction, resume from the exact source path and pending presentation ID. For a new independent project with no assigned directory, inspect the workspace and create an unused directory even when another project has the same name. Build and start the app with exec_command workdir set to that actual project folder. Keep the server as an owned background command and use its actual bound loopback URL from startup output. For an explicitly requested Vite port use --strictPort and report a collision before switching ports. Confirm the owned process is still running and verify a project-specific page marker or response from the files you just built. An HTTP 200 by itself cannot prove that your server started. For a server-backed site, use browser_tabs action=new with the verified URL and test the returned Workbench tab. If Workbench reports a port conflict, use a different port for this chat’s server. For an offline artifact, import the actual HTML file or build with artifact action=import. Do not read, transcribe, simplify, or rewrite the build to fit tool output. Describe the presentation only when confirmed.\n" + provider.modelInstruction(model.id);
    const prompt = entry.apiWorker ? entry.deliveryText ?? entry.text : thread.messages.length
      ? await prepareSkillFollowup(entry.text, entry.text, undefined, { sessionId: entry.sessionId, chatProvider: provider.id })
      : await prepareSessionPrompt(entry.text, { sessionId: entry.sessionId, chatProvider: provider.id, autoSkills: entry.autoSkills });
    const submitted = entry.steerTurnId
      ? 'The user supplied this direction during the ongoing task. Continue the existing objective with this update; preserve completed work, running commands and workers. Use the saved tool results and process IDs. Do not restart the task or repeat earlier actions.\n\n' + prompt
      : prompt;
    const user = await apiUserMessage(submitted, claimed, model, controller.signal);
    let messages: ApiMessage[] = [...thread.messages, user];
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
    const compactContext = async (aggressive = false): Promise<boolean> => {
      const pending = !accepted ? messages.at(-1) : null;
      const workflowId='api-'+randomUUID(),progress=apiCompactionProgress(turn.sessionId,workflowId,false,accepted?turn.turnId:undefined);
      active.activity = {phase:'compacting',inputId:entry.id,since:Date.now()};notifyChanged(turn.sessionId);
      try{
      await progress('Preparing Compact & Resume.',{state:'archiving'});
      const result = await compactApiContext({thread,provider,model,system,tools:declarations,signal:controller.signal,aggressive,
        reserveTokens:pending?contextTokens([pending])-contextTokens([]):0,
        reserveBytes: pending ? Buffer.byteLength(JSON.stringify(pending)) : 0,
        retainMessages:new Set([...publications].flatMap(receipt=>publicationMessages.has(receipt)?[publicationMessages.get(receipt)!]:[])),
        current: async()=> {
          if (controller.signal.aborted || isChatBlocked(turn.conversationId) || await conversationWasSuperseded(turn.conversationId)) return false;
          if (accepted) return currentApiTurn(turn);
          const live=(await listInputs()).find(row=>row.id===entry.id);
          return live?.state==='browser' && live.owner===apiInputOwner(provider.id) && live.sessionId===entry.sessionId &&
            live.conversationId===conversationId && !live.cancelledByUser &&
            (await getSession(entry.sessionId!))?.conversationId===conversationId;
        }, progress: async (text,update)=>{
          active.activity={phase:'compacting',inputId:entry.id,since:Date.now(),reason:text};
          await progress(text,update??{state:'summarizing'});
          if(!accepted)await noteApiInputRecovery(entry.id,apiInputOwner(provider.id),'Compacting context before sending.');
        }});
      if(!result){await progress('Context already fits; continuing without replacing history.',{state:'unchanged'});active.compactionRequested=false;return false;}
      await progress('Saving the reduced working context.',{state:'saving'});
      const checkpoint={...result.checkpoint,workflowId,summary:result.summary,manual:false};
      const next={...thread,messages:result.messages,checkpoint};
      await saveThread(next);
      // Only the successful durable swap changes the active context. Tools and
      // all original messages remain in the archive/canonical history.
      thread.messages=next.messages;thread.checkpoint=next.checkpoint;
      if(pending)messages=[...thread.messages,pending];
      for(const receipt of publications)if(!thread.messages.includes(publicationMessages.get(receipt)!)){
        receipt.failed=true;publications.delete(receipt);publicationMessages.delete(receipt);
      }
      active.compactionRequested=false;
      const text=`Context compacted from approximately ${result.checkpoint.beforeTokens} to ${result.checkpoint.afterTokens} input tokens. Continuing the same task; original history and running processes are retained.`;
      await progress(text,{state:'saved',beforeTokens:checkpoint.beforeTokens,afterTokens:checkpoint.afterTokens,
        summary:{text:result.summary,chars:result.summary.length,truncated:false}});
      if(!accepted)await noteApiInputRecovery(entry.id,apiInputOwner(provider.id),'Context saved; preparing to resume.');
      return true;
      }catch(error){
        await progress(controller.signal.aborted?'Compaction cancelled; original history is retained.':apiFailureDescription(error),
          {state:controller.signal.aborted?'cancelled':'failed',reasonCode:error instanceof ApiError?error.code:undefined}).catch(()=>undefined);
        throw error;
      }
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
      thread.toolContextTokens=contextTokens([],declarations)-contextTokens([]);
      thread.systemContextTokens=contextTokens([{role:'system',content:system}])-contextTokens([]);
      thread.contextWindow=model.contextLength;
      let requestMessages: ApiMessage[] = [{ role: "system", content: system }, ...(!accepted ? messages : thread.messages)];
      if(active.compactionRequested || getConfig().compaction.auto && apiContextNeedsCompaction(model,requestMessages,declarations)){
        await compactContext();
        requestMessages=[{role:'system',content:system},...(!accepted?messages:thread.messages)];
      }
      assertApiInputSupported(model, requestMessages);
      let { output, maximum } = apiOutputBudget(model, requestMessages, declarations, desiredOutput);
      let dispatchedAt = 0;
      const complete = () => provider.complete({ model: model.id, sessionId: turn.conversationId,
        messages: requestMessages, inputModalities: model.inputModalities, tools: declarations, maxCompletionTokens: output, signal: controller.signal,
        reasoningEffort: reasoning, onAccepted: async () => {
          if (dispatchedAt) logInfo(`api timing input=${entry.id} round=${round} header_wait_ms=${Date.now() - dispatchedAt}`);
          await firstAccepted(); active.activity = { phase: 'responding', since: Date.now() }; notifyChanged(turn.sessionId);
          const checkpoint=thread.checkpoint;
          if(checkpoint?.workflowId && !checkpoint.resumedAt){
            checkpoint.resumedAt=Date.now();await saveThread(thread);
            await apiCompactionProgress(turn.sessionId,checkpoint.workflowId,checkpoint.manual??false,turn.turnId)(
              'Task resumed in the same chat from the saved handoff.',{state:'resumed',beforeTokens:checkpoint.beforeTokens,afterTokens:checkpoint.afterTokens,
                ...(checkpoint.summary?{summary:{text:checkpoint.summary,chars:checkpoint.summary.length,truncated:false}}:{})});
          }
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
      let contextRecoveries = 0;
      for (let attempt = 0; ; attempt++) {
        controller.signal.throwIfAborted();
        try { response = await complete(); break; }
        catch (error) {
          controller.signal.throwIfAborted();
          // Storage/receipt failures and tool execution never enter an inference retry.
          if (accepted && await yieldToDirection()) return;
          if(getConfig().compaction.auto && error instanceof ApiError && error.code==='CONTEXT_LIMIT' && contextRecoveries++<2){
            clearPaintTimer();await painting;
            if(accepted && displayed)await upsertMessageEvent(turn.sessionId,assistantRow(displayed,answerId,messageId,turn.turnId,model.id,false));
            displayed='';answerId=randomUUID();paintedAt=0;
            if(!await compactContext(true))throw error;
            requestMessages=[{role:'system',content:system},...(!accepted?messages:thread.messages)];
            ({output,maximum}=apiOutputBudget(model,requestMessages,declarations,Math.min(desiredOutput,8192)));
            continue;
          }
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
      publicationMessages.clear();
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
      // Naming does not wait for the entire agentic task to finish. Existing
      // folder-style provider names get one metadata upgrade in this version.
      try {
        const summary = await getSession(turn.sessionId);
        if (!controller.signal.aborted && thread.titleVersion !== API_TITLE_VERSION && !entry.apiWorker && summary && apiTitleEligible(summary) &&
            (!summary.origin || summary.origin.kind === 'desktop')) {
          thread.titleRequested = true; thread.titleVersion = API_TITLE_VERSION; await saveThread(thread);
          const first = thread.messages.find(row => row.role === 'user')?.content;
          const question = typeof first === 'string' ? first : first?.[0]?.type === 'text' ? first[0].text : entry.text;
          generateApiTopicTitle(turn.sessionId, conversationId, question ?? entry.text, resultContent, provider, model);
        }
      } catch { /* Optional naming cannot fail task execution or replay tools. */ }
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
        if(active.compactionRequested)await compactContext();
        await painting;
        await upsertMessageEvent(turn.sessionId, assistantRow(displayed || resultContent, answerId, messageId, turn.turnId, response.model || model.id, true));
        if (!entry.apiWorker) await preview.present(turn, startedAt).catch(async (error: unknown) => {
          if (!(error instanceof Error) || !error.message.startsWith('ARTIFACT_BUILD_UNSUPPORTED:') || !await currentApiTurn(turn)) return;
          const text = error.message.slice('ARTIFACT_BUILD_UNSUPPORTED: '.length);
          await appendEvent(turn.sessionId, { kind: 'progress', source: 'app', time: Date.now(), turnId: turn.turnId,
            message: { text, chars: text.length, truncated: false } }).catch(() => undefined);
        });
        await appendEvent(turn.sessionId, { kind: "turn_end", source: "app", time: Date.now(),
          turnId: turn.turnId, outcome: "completed" });
        await finishApiWorker(entry, displayed || resultContent || "Worker completed without a text report.");
        notifyChanged(turn.sessionId);
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
        const toolMessage:ApiMessage={ role: "tool", tool_call_id: call.id, content: rendered.text + repeated.guidance };
        thread.messages.push(toolMessage);publicationMessages.set(publication,toolMessage);
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
