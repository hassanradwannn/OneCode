/** API delivery adapter for the existing broker. The outbox owns dispatch, not a second queue. */
import { createHash } from 'node:crypto';
import { getConfig } from '../config.js';
import * as broker from '../agents.js';
import { createSession, findSessionByConversation, getSession, appendEvent } from '../session/store.js';
import { enqueueApiWorkerInput, listInputs, failBrowserInput, type InputEntry } from '../session/input.js';
import { prepareSessionPrompt } from '../session/prompt.js';
import { acceptAgentMutation } from '../agent-admission.js';
import { lookupWorkerWorkspace, validateWorkerWorkspaceLease } from '../worktrees/index.js';
import { apiProvider, apiInputOwner } from './providers.js';
import { chatProviderForStoredConversation } from '../../shared/chat-provider.js';
import { logWarn } from '../logger.js';
import { scheduleApiInput } from './runner.js';

const flights = new Map<string, Promise<void>>();
/** Locally generated identities derive only from an accepted broker incarnation/assignment. */
function localId(value: string): string {
  const bytes = createHash('sha256').update(value).digest();
  bytes[6] = (bytes[6]! & 15) | 64; bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const key = (worker: { runId: string; id: string }) => `${worker.runId}/${worker.id}`;
function launch(worker: { runId: string; id: string }, work: () => Promise<void>): void {
  if (flights.has(key(worker))) return;
  const flight = work().catch(async () => {
    // Never retry an uncertain remote dispatch. A future explicit assignment can wake a stopped worker.
    broker.failAgent(worker.id, 'API worker delivery failed; inspect its recorded input and tool results before retrying.',
      undefined, {}, worker.runId);
    await broker.persistCriticalSwarmNow();
    logWarn('API worker delivery failed; existing outbox receipts retained');
  });
  flights.set(key(worker), flight);
  void flight.finally(() => { if (flights.get(key(worker)) === flight) flights.delete(key(worker)); }).catch(() => undefined);
}

export function deliverApiWorkerSpawns(workers: broker.WorkerSpawn[]): void {
  for (const worker of workers) launch(worker, () => spawn(worker));
}
export function deliverApiWorkerRevivals(workers: broker.WorkerRevival[]): void {
  for (const worker of workers) launch(worker, () => revive(worker));
}

async function spawn(worker: broker.WorkerSpawn): Promise<void> {
  const providerId = chatProviderForStoredConversation(worker.primeConversationId);
  const provider = providerId && apiProvider(providerId);
  if (!provider || !getConfig().multiAgent.enabled) return;
  const inputId = localId(`api-worker-start/${key(worker)}`);
  const conversationId = `${provider.id}:${inputId}`;
  const stillOwned = () => getConfig().multiAgent.enabled &&
    (broker.pendingWorkerSpawns().some(row => key(row) === key(worker)) ||
      broker.agentConversation(worker.id, worker.runId) === conversationId &&
      broker.agentInfoForOwnedConversation(conversationId)?.state === 'active');
  if (!stillOwned()) return;
  const previous = (await listInputs()).find(row => row.id === inputId);
  if (previous && (previous.state !== 'queued' || previous.sendAuthorizedAt !== undefined)) return;
  const parent = await findSessionByConversation(worker.primeConversationId!, { requireUnique: true });
  if (!parent || !stillOwned()) return;
  const session = await createSession({ reservedId: inputId, conversationId,
    title: worker.id, origin: { kind: 'worker', agentId: worker.id, task: worker.task, fromSessionId: parent.id } });
  const allocation = broker.workerBootstrapWorktreeIdentity(worker.runId, worker.id);
  let workingDirectory: string | undefined;
  if (allocation) {
    const lease = lookupWorkerWorkspace(allocation);
    if (!lease) throw new Error('API worker workspace unavailable');
    workingDirectory = (await validateWorkerWorkspaceLease(lease, getConfig().roots)).workspace.virtual;
  }
  const text = previous?.text ?? await prepareSessionPrompt(`${worker.task}\n\n(OneCode: you are ${worker.id}, a worker. ` +
    'Report to prime using agents action=message to="prime". Finish with agents action=finish and your verified result. ' +
    'Workers cannot spawn workers. Follow later prime assignments within the user permissions.)',
    { sessionId: session.id, chatProvider: provider.id, workingDirectory });
  if (!stillOwned() ||
      !broker.bindConversation(worker.id, conversationId, worker.runId)) return;
  if (!await broker.persistCriticalSwarmNow()) throw new Error('API worker binding is not durable');
  const entry = await enqueueApiWorkerInput({ id: inputId, sessionId: session.id, provider: provider.id,
    text, mode: 'auto', dueAt: 0, model: previous?.model ?? worker.model ?? parent.selectedModel?.model ?? provider.defaultModel.id,
    reasoningEffort: previous?.reasoningEffort ?? worker.reasoningEffort }, { runId: worker.runId, agentId: worker.id, messageIds: [] });
  if (entry.state === 'queued') scheduleApiInput(entry);
}

async function revive(worker: broker.WorkerRevival): Promise<void> {
  const providerId = chatProviderForStoredConversation(worker.conversationId);
  const provider = providerId && apiProvider(providerId);
  if (!provider || !getConfig().multiAgent.enabled) return;
  const owed = broker.pendingWorkerRevivals().find(row => key(row) === key(worker));
  if (!owed || JSON.stringify(owed.messageIds) !== JSON.stringify(worker.messageIds)) return;
  const unresolved = (await listInputs()).find(entry => entry.apiWorker?.runId === worker.runId &&
    entry.apiWorker.agentId === worker.id && ['queued', 'browser'].includes(entry.state));
  if (unresolved) {
    if (unresolved.state === 'queued') scheduleApiInput(unresolved);
    return;
  }
  const session = await findSessionByConversation(worker.conversationId, { requireUnique: true });
  const info = broker.agentInfoForOwnedConversation(worker.conversationId);
  if (!session || !info || !broker.claimWorkerRevival(worker.id, worker.conversationId, worker.runId)) return;
  if (!await broker.persistCriticalSwarmNow()) throw new Error('API revival is not durable');
  const entry = await enqueueApiWorkerInput({ id: localId(`api-worker-wake/${key(worker)}/${worker.messageIds.join('/')}`),
    sessionId: session.id, provider: provider.id, text: worker.text, mode: 'auto', dueAt: 0,
    model: info.model ?? session.selectedModel?.model ?? provider.defaultModel.id, reasoningEffort: info.reasoningEffort },
    { runId: worker.runId, agentId: worker.id, messageIds: worker.messageIds });
  if (entry.state === 'queued') scheduleApiInput(entry);
}

/** Every use rechecks the broker incarnation and exact worker conversation. */
export async function apiWorkerInputCurrent(entry: InputEntry): Promise<boolean> {
  const receipt = entry.apiWorker;
  if (!receipt || !entry.sessionId || !entry.conversationId || !getConfig().multiAgent.enabled ||
      broker.agentConversation(receipt.agentId, receipt.runId) !== entry.conversationId) return false;
  const info = broker.agentInfoForOwnedConversation(entry.conversationId);
  if (info?.id !== receipt.agentId || !['active', 'waking'].includes(info.state)) return false;
  const session = await getSession(entry.sessionId);
  return session?.conversationId === entry.conversationId && session.origin?.kind === 'worker' &&
    session.origin.agentId === receipt.agentId &&
    broker.agentConversation(receipt.agentId, receipt.runId) === entry.conversationId;
}

export async function acknowledgeApiWorker(entry: InputEntry): Promise<void> {
  if (!entry.apiWorker || !entry.conversationId) return;
  if (broker.agentInfoForOwnedConversation(entry.conversationId)?.state === 'waking' &&
      !broker.noteWorkerRevived(entry.apiWorker.agentId, entry.conversationId,
        entry.apiWorker.messageIds, entry.id, entry.apiWorker.runId)) throw new Error('API worker revival changed');
  broker.noteAgentAlive(entry.conversationId, 'turn');
  if (!await broker.persistCriticalSwarmNow()) throw new Error('API worker receipt is not durable');
}

/** Automatic final reports use the same broker transaction as a completed browser answer. */
export async function finishApiWorker(entry: InputEntry, result: string, stopped = false): Promise<void> {
  if (!entry.apiWorker || !entry.conversationId ||
      broker.agentConversation(entry.apiWorker.agentId, entry.apiWorker.runId) !== entry.conversationId) return;
  const staged = stopped ? broker.stageWorkerConversationStop(entry.conversationId)
    : broker.stageWorkerConversationFinish(entry.conversationId, result);
  if (staged) await acceptAgentMutation(staged, 'API worker result could not be saved');
}

/** Restart only undispatched durable inputs. A charged request or dispatched tool is never replayed. */
export async function recoverApiWorkers(): Promise<void> {
  const entries = await listInputs();
  for (const entry of entries) {
    if (!entry.chatProvider || !apiProvider(entry.chatProvider)) continue;
    if (entry.state === 'browser' && entry.owner === apiInputOwner(entry.chatProvider))
      await failBrowserInput(entry.id, entry.owner, 'API request interrupted by application restart. Dispatch may have reached the provider; it was not repeated.');
    if (entry.sendAuthorizedAt !== undefined && entry.sessionId) {
      const session = await getSession(entry.sessionId);
      if (session?.activeTurnId && session.timelineTurns?.[session.activeTurnId]?.questionId === entry.messageId) {
        await appendEvent(session.id, { kind: 'chat_error', source: 'app', time: Date.now(), turnId: session.activeTurnId,
          message: { text: 'API_REQUEST_INTERRUPTED', chars: 23, truncated: false } });
        await appendEvent(session.id, { kind: 'turn_end', source: 'app', time: Date.now(),
          turnId: session.activeTurnId, outcome: 'interrupted' });
        await finishApiWorker(entry, 'API request interrupted by application restart. Inspect saved tool outcomes before assigning more work.');
      }
    }
  }
  for (const entry of entries) if (entry.chatProvider && apiProvider(entry.chatProvider) &&
      entry.state === 'queued' && entry.sendAuthorizedAt === undefined) scheduleApiInput(entry);
  deliverApiWorkerSpawns(broker.pendingWorkerSpawns().filter(row => {
    const provider = chatProviderForStoredConversation(row.primeConversationId); return !!provider && !!apiProvider(provider);
  }));
  // Recover a crash between the broker's local binding and outbox publication. Only an
  // exact accepted incarnation can reconstruct this undispatched initial assignment.
  for (const runId of broker.activeRunIds()) {
    const prime = broker.primeConversation(runId);
    const provider = chatProviderForStoredConversation(prime);
    if (!prime || !provider || !apiProvider(provider)) continue;
    const state = broker.swarmStateForCaller({ conversationId: prime, runId });
    deliverApiWorkerSpawns(state.agents.filter(info => info.role === 'worker' && info.state === 'active' &&
      !entries.some(entry => entry.id === localId(`api-worker-start/${runId}/${info.id}`) &&
        (entry.apiWorker || entry.sendAuthorizedAt !== undefined)))
      .map(info => ({ runId, primeConversationId: prime, id: info.id, task: info.task,
        model: info.model, reasoningEffort: info.reasoningEffort })));
  }
  deliverApiWorkerRevivals(broker.pendingWorkerRevivals().filter(row => {
    const provider = chatProviderForStoredConversation(row.conversationId); return !!provider && !!apiProvider(provider);
  }));
}

/** Proof-storage failure must leave Settings/history recovery reachable in the desktop. */
export async function recoverApiWorkersAtStartup(): Promise<void> {
  try { await recoverApiWorkers(); }
  catch { logWarn('API recovery deferred: task storage is unavailable; no unproven request will be dispatched.'); }
}
