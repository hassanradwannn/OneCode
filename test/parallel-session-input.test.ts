import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { initConfigPath, defaultConfig, saveConfig } from '../src/main/config.js';
import { initDurableStore, flushDurable, resetDurableForTests } from '../src/main/durable.js';
import { createSession, initSessionStore, getSession, resetSessionStoreForTests } from '../src/main/session/store.js';
import { sessionInputActivity } from '../src/main/bridge.js';
import { enqueueInput, pendingBrowserInputs, claimBrowserInput, sessionInputPolicy, configureInputDelivery, resetInputForTests } from '../src/main/session/input.js';
import { emptyEvidence, runningToolCalls, trackInFlight, type CallContext } from '../src/main/mcp/call-context.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let directory: string;
const chatA = '11111111-1111-4111-8111-111111111111';
const chatB = '22222222-2222-4222-8222-222222222222';
beforeEach(async () => {
  directory = await makeTempDir('onecode-parallel-input-');
  initConfigPath(directory); initDurableStore(directory); initSessionStore(directory); resetInputForTests();
  const config = defaultConfig(); config.ui.chatProvider = 'chatgpt'; await saveConfig(config);
  configureInputDelivery({activity: sessionInputActivity, changed: () => {}, applyAutomation: async () => {}});
});
afterEach(async () => {
  await flushDurable(); resetInputForTests(); resetSessionStoreForTests(); resetDurableForTests(); await removeTempDir(directory);
});
async function withCall(owner: string | null, run: () => Promise<void>) {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const context: CallContext = {startedAt: Date.now(), transportKey: null, agent: null,
    caller: {transportKey: null, requestId: null, conversationId: owner}, outcome: null, evidence: emptyEvidence()};
  const active = trackInFlight(context, () => gate);
  try { await run(); } finally { release(); await active; }
}
const request = (sessionId: string | null) => ({id: randomUUID(), sessionId, text: 'Harmless parallel check',
  mode: 'auto' as const, dueAt: Date.now(), model: null, reasoningEffort: null});

it.each([null, chatA])('allows an idle second chat while another or unassigned call runs: %s', async owner => {
  await createSession({conversationId: chatA});
  const b = await createSession({conversationId: chatB});
  await withCall(owner, async () => {
    expect(runningToolCalls()).toBe(1); // Global update/compaction barrier remains conservative.
    expect(sessionInputActivity((await getSession(b.id))!)).toMatchObject({possible: false, exact: false});
    expect((await sessionInputPolicy(b.id)).browserAllowed).toBe(true);
    const row = await enqueueInput(request(b.id));
    expect(await pendingBrowserInputs()).toContainEqual(expect.objectContaining({id: row.id, conversationId: chatB}));
    expect(await claimBrowserInput(row.id, 'parallel-document', chatB, true)).toMatchObject({id: row.id, state: 'browser'});
    expect(runningToolCalls()).toBe(1);
  });
});

it('starts two distinct fresh chats before an anonymous call finishes', async () => {
  await withCall(null, async () => {
    const [a, b] = await Promise.all([enqueueInput(request(null)), enqueueInput(request(null))]);
    expect(a.sessionId).not.toBe(b.sessionId);
    expect(await pendingBrowserInputs()).toHaveLength(2);
    expect(await claimBrowserInput(a.id, 'document-a', null, true)).toMatchObject({id: a.id});
    expect(await claimBrowserInput(b.id, 'document-b', null, true)).toMatchObject({id: b.id});
    expect(runningToolCalls()).toBe(1);
  });
});

it('continues to hold input to the chat that actually owns a running call', async () => {
  const a = await createSession({conversationId: chatA});
  await withCall(chatA, async () => {
    expect(sessionInputActivity((await getSession(a.id))!)).toMatchObject({possible: true, exact: true});
    expect((await sessionInputPolicy(a.id)).browserAllowed).toBe(false);
  });
});
