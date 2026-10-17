import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { makeTempDir, removeTempDir } from './helpers.js';
import { createSession, flushSessions, initSessionStore, rebindSession, resetSessionStoreForTests } from '../src/main/session/store.js';
import { authenticateGeminiBinding, ensureGeminiBinding, geminiBindingIsCurrent, geminiBindingsEnabled,
  initGeminiBindings, resetGeminiBindingsForTests, revokeGeminiBinding, rotateGeminiBinding,
  stripGeminiRoutingArgs, validateGeminiBindingEvidence } from '../src/main/gemini/bindings.js';

const CHAT_A = 'aaaaaaaaaaaaaaaa';
const CHAT_B = 'bbbbbbbbbbbbbbbb';
let directory: string;
beforeEach(async () => {
  directory = await makeTempDir('gemini-bindings-');
  initSessionStore(directory);
  await initGeminiBindings(directory);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await flushSessions();
  await resetGeminiBindingsForTests();
  resetSessionStoreForTests();
  await removeTempDir(directory);
});

describe('Gemini durable local session capabilities', () => {
  it('requires an existing unique attached durable session; a conversation id alone grants nothing', async () => {
    await expect(ensureGeminiBinding(CHAT_A)).rejects.toThrow('GEMINI_SESSION_NOT_ATTACHED');
    const session = await createSession({ conversationId: CHAT_A });
    await expect(ensureGeminiBinding(CHAT_A, 'wrong-session')).rejects.toThrow('GEMINI_SESSION_NOT_ATTACHED');
    const key = await ensureGeminiBinding(CHAT_A, session.id);
    expect(await ensureGeminiBinding(CHAT_A, session.id)).toEqual(key);
    expect(await authenticateGeminiBinding(key)).toMatchObject({ conversationId: CHAT_A, sessionId: session.id,
      attribution: 'gemini_session_capability' });
    await createSession({ conversationId: CHAT_A });
    await expect(ensureGeminiBinding(CHAT_A)).rejects.toThrow('GEMINI_SESSION_NOT_ATTACHED');
    await expect(authenticateGeminiBinding(key)).rejects.toThrow('GEMINI_SESSION_NOT_ATTACHED');
  });

  it('keeps simultaneous chat credentials separate and consumes routing before strict tool validation', async () => {
    await createSession({ conversationId: CHAT_A });
    await createSession({ conversationId: CHAT_B });
    const [a, b] = await Promise.all([ensureGeminiBinding(CHAT_A), ensureGeminiBinding(CHAT_B)]);
    expect(a.session_key).not.toBe(b.session_key);
    await expect(authenticateGeminiBinding({ ...a, conversation_id: CHAT_B })).rejects.toThrow('GEMINI_SESSION_NOT_AUTHORIZED');
    await expect(authenticateGeminiBinding({ conversation_id: CHAT_A })).rejects.toThrow('GEMINI_SESSION_BINDING_REQUIRED');
    expect(stripGeminiRoutingArgs({ conversation_id: CHAT_A, session_key: a.session_key, path: '/a' })).toEqual({ path: '/a' });
  });

  it('persists hashes only, restores authorization, then explicitly rotates when issuing after restart', async () => {
    await createSession({ conversationId: CHAT_A });
    const first = await ensureGeminiBinding(CHAT_A);
    const disk = await fs.readFile(path.join(directory, 'state', 'gemini-bindings.json'), 'utf8');
    expect(disk).not.toContain(first.session_key);
    expect(disk).not.toContain('sk-gemini-session-');
    await flushSessions(); resetSessionStoreForTests(); initSessionStore(directory);
    await initGeminiBindings(directory);
    expect((await authenticateGeminiBinding(first)).conversationId).toBe(CHAT_A);
    const second = await ensureGeminiBinding(CHAT_A);
    expect(second.session_key).not.toBe(first.session_key);
    await expect(authenticateGeminiBinding(first)).rejects.toThrow('GEMINI_SESSION_NOT_AUTHORIZED');
    expect((await authenticateGeminiBinding(second)).conversationId).toBe(CHAT_A);
  });

  it('revokes already validated parent evidence so a delayed/nested child cannot reuse it', async () => {
    await createSession({ conversationId: CHAT_A });
    const key = await ensureGeminiBinding(CHAT_A);
    const proof = await authenticateGeminiBinding(key);
    expect(geminiBindingIsCurrent(proof)).toBe(true);
    await revokeGeminiBinding(CHAT_A);
    expect(geminiBindingIsCurrent(proof)).toBe(false);
    await expect(validateGeminiBindingEvidence(proof)).rejects.toThrow('GEMINI_SESSION_AUTHORIZATION_EXPIRED');
    await expect(authenticateGeminiBinding(key)).rejects.toThrow('GEMINI_SESSION_AUTHORIZATION_EXPIRED');
    const fresh = await rotateGeminiBinding(CHAT_A);
    expect((await authenticateGeminiBinding(fresh)).bindingId).not.toBe(proof.bindingId);
  });

  it('expires a capability and refuses the old frontend after a durable Compact & Resume rebind', async () => {
    const session = await createSession({ conversationId: CHAT_A });
    const key = await ensureGeminiBinding(CHAT_A);
    const proof = await authenticateGeminiBinding(key);
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 8 * 24 * 60 * 60 * 1000);
    await expect(authenticateGeminiBinding(key)).rejects.toThrow('GEMINI_SESSION_AUTHORIZATION_EXPIRED');
    clock.mockRestore();
    expect(await rebindSession(session.id, CHAT_A, CHAT_B)).toBe(true);
    await expect(authenticateGeminiBinding(key)).rejects.toThrow('GEMINI_SESSION_NOT_ATTACHED');
    await expect(validateGeminiBindingEvidence(proof)).rejects.toThrow('GEMINI_SESSION_NOT_ATTACHED');
    const destination = await ensureGeminiBinding(CHAT_B, session.id);
    expect((await authenticateGeminiBinding(destination)).sessionId).toBe(session.id);
  });

  it('fails closed on corrupt authority state instead of enabling legacy unattributed fallback', async () => {
    await fs.mkdir(path.join(directory, 'state'), { recursive: true });
    await fs.writeFile(path.join(directory, 'state', 'gemini-bindings.json'), '{broken');
    await expect(initGeminiBindings(directory)).rejects.toThrow('GEMINI_BINDING_STATE_INVALID');
    expect(geminiBindingsEnabled()).toBe(true);
    await expect(ensureGeminiBinding(CHAT_A)).rejects.toThrow('GEMINI_BINDING_STATE_UNAVAILABLE');
    await expect(authenticateGeminiBinding({})).rejects.toThrow('GEMINI_BINDING_STATE_UNAVAILABLE');
  });
});
