import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { backgroundProviderSource } from './helpers.js';
import { CHAT_PROVIDERS, type ChatProvider } from '../src/shared/chat-provider.js';

const source = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const id = 'ea972ba88cc341c6';
const other = '9c16a67b1d474b59';
function fragment(start: string, end: string) {
  const from = source.indexOf(start); const to = source.indexOf(end, from);
  if (from < 0 || to < 0) throw new Error('Production adapter fragment not found');
  return source.slice(from, to);
}

describe('Gemini recorder repair injection', () => {
  const healthyFixtures: Record<ChatProvider, { url: string; helperFiles: string[] }> = {
    chatgpt: { url: 'https://chatgpt.com/', helperFiles: ['usage.js', 'fiber.js'] },
    gemini: { url: 'https://gemini.google.com/app', helperFiles: [] }
  };
  it.each(CHAT_PROVIDERS)('preserves the healthy %s adapter/recorder pair for an exact-document repair', async provider => {
    const injected: string[] = [], tabReply = vi.fn(async () => ({ ok: true, recorderVersion: 23 }));
    const context: any = { URL, PAGE_RECORDER_VERSION: 23, tabReply, chrome: { tabs: { get: async () => ({ url: healthyFixtures[provider].url }) },
      scripting: { executeScript: vi.fn(async ({ files }: any) => { injected.push(...files); }), insertCSS: vi.fn() } } };
    vm.createContext(context); vm.runInContext(backgroundProviderSource(source), context);
    vm.runInContext(fragment('async function restoreChatgptTab(', '\n// The existing maintenance owner'), context);
    expect(await context.restoreChatgptTab(10, () => true, 'document-test')).toBe(true);
    expect(tabReply).toHaveBeenCalledWith(10, { type: 'clf-recorder-ping' }, { documentId: 'document-test' });
    expect(injected).toEqual(healthyFixtures[provider].helperFiles);
  });

  it('serializes concurrent repair of one document so a second adapter cannot erase the first recorder callbacks', async () => {
    let healthy = false;
    const injected: string[] = [];
    const context: any = { URL, PAGE_RECORDER_VERSION: 23, tabReply: vi.fn(async () => ({ ok: healthy, recorderVersion: 23 })),
      chrome: { tabs: { get: async () => ({ url: 'https://gemini.google.com/app' }) }, scripting: {
        executeScript: vi.fn(async ({ files }: any) => { injected.push(...files); if (files.includes('content.js')) healthy = true; }), insertCSS: vi.fn() } } };
    vm.createContext(context); vm.runInContext(backgroundProviderSource(source), context);
    vm.runInContext(fragment('async function restoreChatgptTab(', '\n// The existing maintenance owner'), context);
    expect(await Promise.all([context.restoreChatgptTab(10, () => true, 'document-test'), context.restoreChatgptTab(10, () => true, 'document-test')])).toEqual([true, true]);
    expect(injected.filter(file => file === 'gemini-dom.js')).toHaveLength(1);
    expect(injected.filter(file => file === 'content.js')).toHaveLength(1);
  });

  it('rechecks a replacement document after the preceding repair loses its caller', async () => {
    let originalCurrent = true;
    const targets: string[] = [];
    const context: any = { URL, PAGE_RECORDER_VERSION: 23, tabReply: vi.fn(async () => ({ ok: false })),
      chrome: { tabs: { get: async () => ({ url: 'https://gemini.google.com/app' }) }, scripting: {
        executeScript: vi.fn(async ({ target, files }: any) => {
          targets.push(target.documentIds[0]);
          if (target.documentIds[0] === 'old-document' && files.includes('gemini-markdown.js')) originalCurrent = false;
        }), insertCSS: vi.fn() } } };
    vm.createContext(context); vm.runInContext(backgroundProviderSource(source), context);
    vm.runInContext(fragment('async function restoreChatgptTab(', '\n// The existing maintenance owner'), context);
    expect(await Promise.all([context.restoreChatgptTab(10, () => originalCurrent, 'old-document'), context.restoreChatgptTab(10, () => true, 'new-document')])).toEqual([false, true]);
    expect(targets).toEqual(['old-document', 'old-document', 'new-document', 'new-document', 'new-document', 'new-document']);
  });

  it.each([false, true])('restores the actual Markdown helper before the adapter while retaining exact document custody, revoked=%s', async revoked => {
    const page = new JSDOM('<model-response><message-content><code-block><div class="code-block-decoration"><span>JSON</span></div><pre><code data-test-id="code-content">{"actual":true}</code></pre></code-block></message-content></model-response>', { runScripts: 'outside-only' });
    let current = true;
    const injected: string[] = [];
    const context: any = { URL, PAGE_RECORDER_VERSION: 1, chrome: { tabs: { get: async () => ({ url: 'https://gemini.google.com/app' }) }, scripting: {
      executeScript: vi.fn(async ({ target, files }: any) => {
        expect(target).toEqual({ tabId: 10, documentIds: ['document-test'] });
        injected.push(...files);
        if (files[0] === 'gemini-markdown.js') {
          page.window.eval(readFileSync(new URL('../extension/gemini-markdown.js', import.meta.url), 'utf8'));
          if (revoked) current = false;
        }
        if (files[0] === 'content.js') {
          expect((page.window as any).CLF_GEMINI_MARKDOWN.render(page.window.document.querySelector('message-content'))).toContain('```json\n{"actual":true}\n```');
        }
      }), insertCSS: vi.fn(async () => {}) } } };
    vm.createContext(context); vm.runInContext(backgroundProviderSource(source), context);
    vm.runInContext(fragment('async function restoreChatgptTab(', '\n// The existing maintenance owner'), context);
    expect(await context.restoreChatgptTab(10, () => current, 'document-test')).toBe(!revoked);
    expect(injected).toEqual(revoked ? ['i18n.js', 'gemini-markdown.js'] : ['i18n.js', 'gemini-markdown.js', 'gemini-dom.js', 'content.js']);
    page.window.close();
  });
});
function harness() {
  let tab = { id: 10, url: `https://gemini.google.com/app/${id}`, pendingUrl: undefined as string | undefined };
  let owns = true;
  const call = vi.fn(async () => ({ ok: true, data: { conversation_id: id, session_key: 'test-only-key-with-no-runtime-permission' } }));
  const state: any = {};
  const redeemCommand = vi.fn(async (commandId: string) => ({ ok: true, command: { id: commandId, type: 'worker' } }));
  const context: any = { URL, inputOpenings: {}, chrome: { tabs: { get: vi.fn(async () => tab) },
    scripting: { executeScript: vi.fn(async () => [{ frameId: 0, documentId: 'document-test', result: tab.url }]) }, storage: { session: {
    get: vi.fn(async () => structuredClone(state)), set: vi.fn(async (value: any) => Object.assign(state, structuredClone(value)))
  } } }, ownsDocument: () => owns, call, redeemCommand, load: async () => {} };
  context.persistLive = vi.fn(async () => { state.inputOpenings = structuredClone(context.inputOpenings); });
  vm.createContext(context); vm.runInContext(backgroundProviderSource(source), context);
  vm.runInContext(fragment('function cleanConversationId(value)', '/**\n * The mode a goal'), context);
  vm.runInContext(fragment('function conversationFromUrl(value)', '/**\n * The ChatGPT Project'), context);
  vm.runInContext(fragment('let geminiCommandWrites = Promise.resolve()', '\nconst HANDLERS ='), context);
  const handler = fragment('  async gemini_binding(message, sender, source)', '\n  // Only the tab this worker opened');
  vm.runInContext(`handler = ({ ${handler} }).gemini_binding`, context);
  vm.runInContext(`redeem = ({ ${fragment('  async redeem(message, _sender, source)', '\n  /**\n   * A revival page')} }).redeem`, context);
  vm.runInContext(`desktop = ({ ${fragment('  async desktop_input(message, sender, source)', '\n  async i18n_catalog')} }).desktop_input`, context);
  vm.runInContext(`goalAuthorize = ({ ${fragment('  async goal_authorize(message, _sender, source)', '\n  /** Typed, or given up on.')} }).goal_authorize`, context);
  vm.runInContext(`goalAck = ({ ${fragment('  async goal_ack(message, _sender, source)', '\n  /**\n   * This chat\'s specific goal')} }).goal_ack`, context);
  return { context, call, state, redeemCommand, sender: () => ({ url: tab.url, tab: { ...tab }, documentId: 'document-test' }), source: { tab: 10, documentId: 'document-test', navigationEpoch: 0 },
    route: (url: string) => { tab = { ...tab, url }; },
    move: () => { tab = { ...tab, url: `https://gemini.google.com/app/${other}` }; },
    pending: () => { tab.pendingUrl = `https://gemini.google.com/app/${other}`; }, retire: () => { owns = false; } };
}

describe('paired Gemini conversation binding relay', () => {
  const inputId = '878ec7a1-9be1-477e-a073-3db6b8d56b92', inputOwner = '10:document-test:0';
  it('relays only the current Goal document, its exact sealed authored text and accepted native receipt', async () => {
    const h = harness(), token = 'goal-scoped-send', text = 'Preserved prefix. Continue the exact next step.', messageId = `gemini:${id}:user:ba53d8ce31d0aabb`;
    await h.context.handler({ conversation_id: id, goal: { token } }, h.sender(), h.source);
    expect(JSON.parse((h.call.mock.calls as any).at(-1)[1].body)).toEqual({ conversation_id: id,
      goal: { token, client: '10', tab_id: 10, document_id: 'document-test' } });
    await h.context.goalAuthorize({ conversationId: id, token, text }, h.sender(), h.source);
    expect(h.call).toHaveBeenLastCalledWith('/goal/authorize', { method: 'POST', body: JSON.stringify({ conversationId: id,
      token, text, clientId: '10', tab_id: 10, document_id: 'document-test' }) });
    await h.context.goalAck({ conversationId: id, token, sent: true, messageId }, h.sender(), h.source);
    expect(JSON.parse((h.call.mock.calls as any).at(-1)[1].body)).toEqual({ conversationId: id, token, sent: true,
      messageId, clientId: '10', tab_id: 10, document_id: 'document-test' });
    await h.context.goalAck({ conversationId: id, token, nativeBusy: true }, h.sender(), h.source);
    expect(JSON.parse((h.call.mock.calls as any).at(-1)[1].body)).toEqual({ conversationId: id, token, nativeBusy: true, clientId: '10' });
  });
  it.each(['opening', 'input', 'command'])('refuses Goal scope combined with another %s claim', async kind => {
    const h = harness();
    expect(await h.context.handler({ conversation_id: id, goal: { token: 'goal-test' }, [kind]: {} }, h.sender(), h.source))
      .toEqual({ ok: false, error: 'binding_claim_ambiguous' });
    expect(h.call).not.toHaveBeenCalled();
  });
  it.each(['route', 'document', 'retired', 'pending navigation'])('refuses Goal authorization/receipt for a changed %s before HTTP', async mode => {
    const h = harness(); if (mode === 'route') h.move(); if (mode === 'retired') h.retire(); if (mode === 'pending navigation') h.pending();
    const source = mode === 'document' ? { ...h.source, documentId: 'foreign-document' } : h.source;
    expect((await h.context.goalAuthorize({ conversationId: id, token: 'goal-test', text: 'Continue.' }, h.sender(), source)).ok).toBe(false);
    expect((await h.context.goalAck({ conversationId: id, token: 'goal-test', sent: true,
      messageId: `gemini:${id}:user:ba53d8ce31d0aabb` }, h.sender(), source)).ok).toBe(false);
    expect(h.call).not.toHaveBeenCalled();
  });
  it('does not forward Goal authority or an ACK response after its native document changes in flight', async () => {
    for (const operation of ['goalAuthorize', 'goalAck']) {
      const h = harness(); h.call.mockImplementationOnce(async () => { h.move(); return { ok: true, data: {} } as any; });
      expect(await h.context[operation]({ conversationId: id, token: 'goal-test', text: 'Continue.', sent: true,
        messageId: `gemini:${id}:user:ba53d8ce31d0aabb` }, h.sender(), h.source)).toEqual({ ok: false, error: 'conversation_changed' });
    }
  });
  async function claimInput(h: ReturnType<typeof harness>, purpose?: string) {
    h.context.inputOpenings[inputId] = { tab: 10, stage: 'ready' };
    h.call.mockResolvedValueOnce({ ok: true, data: { input: { id: inputId, owner: inputOwner, requiresAuthorization: true, purpose } } } as any);
    return h.context.desktop({ id: inputId, conversationId: id, requiresAuthorization: true }, h.sender(), h.source);
  }
  it('relays an existing-chat input only after its canonical claim and retains that exact projection across worker restart', async () => {
    const h = harness();
    await claimInput(h);
    expect(h.context.inputOpenings[inputId]).toMatchObject({ tab: 10, stage: 'ready', inputOwner, inputDocumentId: 'document-test' });
    const proof = { id: inputId, owner: inputOwner };
    expect((await h.context.handler({ conversation_id: id, input: proof }, h.sender(), h.source)).ok).toBe(true);
    expect(JSON.parse((h.call.mock.calls as any).at(-1)[1].body)).toEqual({ conversation_id: id,
      input: { ...proof, tab_id: 10, document_id: 'document-test' } });
    const restarted = harness(); Object.assign(restarted.context.inputOpenings, structuredClone(h.state.inputOpenings));
    expect((await restarted.context.handler({ conversation_id: id, input: proof }, restarted.sender(), restarted.source)).ok).toBe(true);
  });
  it('keeps the same fresh opening and normal input claims across a proven same-document SPA route', async () => {
    const h = harness(); await claimInput(h);
    const proof = { id: inputId, owner: inputOwner }, sender = h.sender(); sender.url = 'https://gemini.google.com/u/1/app';
    expect((await h.context.handler({ conversation_id: id, opening: proof, input: proof }, sender, h.source)).ok).toBe(true);
    expect(JSON.parse((h.call.mock.calls as any).at(-1)[1].body)).toEqual({ conversation_id: id,
      opening: { ...proof, tab_id: 10, document_id: 'document-test' }, input: { ...proof, tab_id: 10, document_id: 'document-test' } });
  });
  it.each(['unclaimed', 'foreign owner', 'foreign document', 'different election', 'decision helper'])(
    'never borrows a normal input claim from %s', async mode => {
    const h = harness(); if (mode !== 'unclaimed') await claimInput(h, mode === 'decision helper' ? 'decision' : undefined);
    if (mode === 'foreign owner') h.context.inputOpenings[inputId].inputOwner = '10:document-test:1';
    if (mode === 'foreign document') h.context.inputOpenings[inputId].inputDocumentId = 'replacement-document';
    if (mode === 'different election') h.context.inputOpenings[inputId].tab = 11;
    h.call.mockClear();
    expect(await h.context.handler({ conversation_id: id, input: { id: inputId, owner: inputOwner } }, h.sender(), h.source))
      .toEqual({ ok: false, error: 'input_claim_mismatch' });
    expect(h.call).not.toHaveBeenCalled();
  });
  it('refuses mismatched opening/input or combined command/input claims before requesting a capability', async () => {
    const h = harness(); await claimInput(h); h.call.mockClear();
    expect(await h.context.handler({ conversation_id: id, opening: { id: inputId, owner: '10:document-test:1' },
      input: { id: inputId, owner: inputOwner } }, h.sender(), h.source)).toEqual({ ok: false, error: 'input_claim_mismatch' });
    expect(await h.context.handler({ conversation_id: id, command: { id: '1234567890abcdef', client: 'client' },
      input: { id: inputId, owner: inputOwner } }, h.sender(), h.source)).toEqual({ ok: false, error: 'binding_claim_ambiguous' });
    expect(h.call).not.toHaveBeenCalled();
  });
  it('does not persist a normal claim after its document retires during the canonical claim reply', async () => {
    const h = harness(); h.context.inputOpenings[inputId] = { tab: 10, stage: 'ready' };
    h.call.mockImplementationOnce(async () => { h.retire(); return { ok: true,
      data: { input: { id: inputId, owner: inputOwner, requiresAuthorization: true } } } as any; });
    await h.context.desktop({ id: inputId, conversationId: id, requiresAuthorization: true }, h.sender(), h.source);
    expect(h.context.inputOpenings[inputId]).not.toHaveProperty('inputOwner');
  });
  it('does not forward a scoped key after its exact input election changes while the backend responds', async () => {
    const h = harness(); await claimInput(h);
    h.call.mockImplementationOnce(async () => { h.context.inputOpenings[inputId] = { tab: 11 }; return { ok: true, data: {} } as any; });
    expect(await h.context.handler({ conversation_id: id, input: { id: inputId, owner: inputOwner } }, h.sender(), h.source))
      .toEqual({ ok: false, error: 'input_claim_mismatch' });
  });
  it('forwards one exact native conversation ID through the authenticated bridge', async () => {
    const h = harness();
    const reply = await h.context.handler({ conversation_id: id }, h.sender(), h.source);
    expect(reply.ok).toBe(true);
    expect(h.call).toHaveBeenCalledWith('/gemini/binding', { method: 'POST', body: JSON.stringify({ conversation_id: id }) });
  });
  it.each(['/u/0', '/u/12'])('binds account-prefixed %s through the same exact Chrome document proof', async prefix => {
    const h = harness(); h.route(`https://gemini.google.com${prefix}/app/${id}?pageId=none`);
    const reply = await h.context.handler({ conversation_id: id }, h.sender(), h.source);
    expect(reply.ok).toBe(true);
    expect(h.call).toHaveBeenCalledWith('/gemini/binding', { method: 'POST', body: JSON.stringify({ conversation_id: id }) });
  });
  it('forwards an original opening claim only from its elected current document', async () => {
    const h = harness(), inputId = '878ec7a1-9be1-477e-a073-3db6b8d56b92', owner = '10:document-test:0';
    h.context.inputOpenings[inputId] = { tab: 10 };
    const result = await h.context.handler({ conversation_id: id, opening: { id: inputId, owner } }, h.sender(), h.source);
    expect(result.ok).toBe(true);
    const requests = h.call.mock.calls as unknown as Array<[string, { body: string }]>;
    expect(JSON.parse(requests[0]![1].body)).toEqual({ conversation_id: id,
      opening: { id: inputId, owner, tab_id: 10, document_id: 'document-test' } });
  });
  it('rejects an opening claim elected to another tab before asking the app for a key', async () => {
    const h = harness(), inputId = '878ec7a1-9be1-477e-a073-3db6b8d56b92';
    h.context.inputOpenings[inputId] = { tab: 11 };
    const result = await h.context.handler({ conversation_id: id, opening: { id: inputId, owner: '10:document-test:0' } }, h.sender(), h.source);
    expect(result).toEqual({ ok: false, error: 'opening_claim_mismatch' }); expect(h.call).not.toHaveBeenCalled();
  });
  it('forwards a redeemed command only from its original client and document, including after an MV3 reload', async () => {
    const h = harness(), command = { id: '1234567890abcdef', client: 'document-random-run-id' };
    expect((await h.context.redeem(command, h.sender(), h.source)).command.id).toBe(command.id);
    const result = await h.context.handler({ conversation_id: id, command }, h.sender(), h.source);
    expect(result.ok).toBe(true);
    expect(JSON.parse((h.call.mock.calls as any)[0][1].body)).toEqual({ conversation_id: id,
      command: { ...command, tab_id: 10, document_id: 'document-test' } });
    const restarted = harness(); Object.assign(restarted.state, structuredClone(h.state));
    expect((await restarted.context.handler({ conversation_id: id, command }, restarted.sender(), restarted.source)).ok).toBe(true);
    expect(await h.context.handler({ conversation_id: id, command: { ...command, client: 'foreign-client' } }, h.sender(), h.source))
      .toEqual({ ok: false, error: 'command_claim_mismatch' });
    expect(await h.context.handler({ conversation_id: id, command }, h.sender(), { ...h.source, documentId: 'replacement-document' }))
      .toEqual({ ok: false, error: 'conversation_changed' });
  });
  it('does not record command custody when the redeem reply arrives for a retired document', async () => {
    const h = harness(), command = { id: '1234567890abcdef', client: 'original-client' };
    let resolve: (value: any) => void = () => {};
    h.redeemCommand.mockImplementationOnce(() => new Promise(done => { resolve = done; }) as any);
    const pending = h.context.redeem(command, h.sender(), h.source);
    h.retire(); resolve({ ok: true, command: { id: command.id } });
    expect(await pending).toEqual({ ok: false, error: 'stale_document' });
    expect(h.state.geminiCommandDocuments).toBeUndefined();
  });
  it('retains two concurrent command owners and refuses ambiguous opening plus command claims', async () => {
    const h = harness();
    const one = { id: '1234567890abcdef', client: 'one' }, two = { id: 'fedcba0987654321', client: 'two' };
    await Promise.all([h.context.redeem(one, h.sender(), h.source), h.context.redeem(two, h.sender(), { ...h.source, tab: 11 })]);
    expect(Object.keys(h.state.geminiCommandDocuments)).toHaveLength(2);
    expect(await h.context.handler({ conversation_id: id, command: one, opening: {} }, h.sender(), h.source))
      .toEqual({ ok: false, error: 'binding_claim_ambiguous' }); expect(h.call).not.toHaveBeenCalled();
  });
  it('rejects a page claiming another conversation', async () => {
    const h = harness();
    expect(await h.context.handler({ conversation_id: other }, h.sender(), h.source)).toEqual({ ok: false, error: 'conversation_changed' });
    expect(h.call).not.toHaveBeenCalled();
  });
  it('binds a proven same-document SPA opening despite stale MessageSender /app URLs', async () => {
    const h = harness(), inputId = '878ec7a1-9be1-477e-a073-3db6b8d56b92', owner = '10:document-test:0';
    h.context.inputOpenings[inputId] = { tab: 10 };
    const sender = { ...h.sender(), url: `https://gemini.google.com/app?cos-input=${inputId}`,
      tab: { ...h.sender().tab, url: `https://gemini.google.com/app?cos-input=${inputId}` } };
    const result = await h.context.handler({ conversation_id: id, opening: { id: inputId, owner } }, sender, h.source);
    expect(result.ok).toBe(true);
    expect(h.context.chrome.scripting.executeScript).toHaveBeenCalledTimes(2);
    expect(h.context.chrome.scripting.executeScript.mock.calls[0][0].target).toEqual({ tabId: 10, documentIds: ['document-test'] });
    expect(JSON.parse((h.call.mock.calls as any)[0][1].body)).toMatchObject({ conversation_id: id,
      opening: { id: inputId, owner, tab_id: 10, document_id: 'document-test' } });
  });
  it('never admits an unrelated sender origin even if another native tab URL looks valid', async () => {
    const h = harness();
    expect(await h.context.handler({ conversation_id: id }, { ...h.sender(), url: 'https://unrelated.invalid/app' }, h.source))
      .toEqual({ ok: false, error: 'conversation_mismatch' });
    expect(h.context.chrome.scripting.executeScript).not.toHaveBeenCalled(); expect(h.call).not.toHaveBeenCalled();
  });
  it.each([
    { frameId: 0, documentId: 'replacement-document', result: `https://gemini.google.com/app/${id}` },
    { frameId: 1, documentId: 'document-test', result: `https://gemini.google.com/app/${id}` },
    { frameId: 0, documentId: 'document-test', result: `https://gemini.google.com/app/${other}` }
  ])('does not substitute a different document, frame or native route: %j', async frame => {
    const h = harness(); h.context.chrome.scripting.executeScript.mockResolvedValue([frame]);
    expect(await h.context.handler({ conversation_id: id }, h.sender(), h.source)).toEqual({ ok: false, error: 'conversation_changed' });
    expect(h.call).not.toHaveBeenCalled();
  });
  it('does not disclose the binding if the exact document is replaced at the same URL during the app reply', async () => {
    const h = harness();
    h.context.chrome.scripting.executeScript.mockResolvedValueOnce([{ frameId: 0, documentId: 'document-test', result: `https://gemini.google.com/app/${id}` }])
      .mockResolvedValueOnce([{ frameId: 0, documentId: 'replacement-document', result: `https://gemini.google.com/app/${id}` }]);
    expect(await h.context.handler({ conversation_id: id }, h.sender(), h.source)).toEqual({ ok: false, error: 'conversation_changed' });
    expect(h.call).toHaveBeenCalledTimes(1);
  });
  it('fails closed if Chrome cannot execute in the original authenticated document', async () => {
    const h = harness(); h.context.chrome.scripting.executeScript.mockRejectedValue(new Error('No document with that ID'));
    expect(await h.context.handler({ conversation_id: id }, h.sender(), h.source)).toEqual({ ok: false, error: 'conversation_changed' });
    expect(h.call).not.toHaveBeenCalled();
  });
  it('does not disclose a scoped key after navigation while the app is responding', async () => {
    const h = harness(); let resolve: (value: any) => void = () => {};
    h.call.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const pending = h.context.handler({ conversation_id: id }, h.sender(), h.source);
    await vi.waitFor(() => expect(h.call).toHaveBeenCalledTimes(1));
    h.move(); resolve({ ok: true, data: { conversation_id: id, session_key: 'test-key' } });
    expect(await pending).toEqual({ ok: false, error: 'conversation_changed' });
  });
  it('does not provision a key for a tab whose next navigation is already pending', async () => {
    const h = harness(); const sender = h.sender(); h.pending();
    expect(await h.context.handler({ conversation_id: id }, sender, h.source)).toEqual({ ok: false, error: 'conversation_changed' });
    expect(h.call).not.toHaveBeenCalled();
  });
  it('does not provision a key from a retired recorder document', async () => {
    const h = harness(); h.retire();
    expect(await h.context.handler({ conversation_id: id }, h.sender(), h.source)).toEqual({ ok: false, error: 'conversation_mismatch' });
    expect(h.call).not.toHaveBeenCalled();
  });
  it('never binds a share link, another origin, or an appended route as a chat', () => {
    const h = harness();
    for (const url of ['https://evil.invalid/app/' + id,
      'https://gemini.google.com/share/' + id, 'https://gemini.google.com/app/' + id + '/more',
      'https://gemini.google.com:444/app/' + id, 'https://gemini.google.com/u/abc/app/' + id, 'https://gemini.google.com/u/0/share/' + id])
      expect(h.context.conversationFromUrl(url)).toBeNull();
    expect(h.context.conversationFromUrl('https://gemini.google.com/app/' + id + '?pageId=none')).toBe(id);
    expect(h.context.conversationFromUrl('https://chatgpt.com/c/' + id)).toBe(id);
    expect(h.context.providerForUrl('https://chatgpt.com:444/c/' + id)).toBeNull();
    expect(h.context.providerForUrl('https://gemini.google.com:444/app/' + id)).toBeNull();
  });
});

describe('background renderer permission and attachment proof', () => {
  it('keeps only a redeemed command document across warm-up and retires its rendering at expiry or document loss', async () => {
    let now = 10, owned = true;
    const receipt = { id: '1234567890abcdef', type: 'worker', expiresAt: 100 };
    const lease = vi.fn(async (_scope: string, _tab: any, current: Function) => current());
    const context: any = { Date: { now: () => now }, commandRenderingScopes: new Map(),
      ownsDocument: (source: any) => owned && source.tab === 10 && source.documentId === 'original-document' && source.navigationEpoch === undefined,
      chrome: { tabs: { get: async () => ({ id: 10, url: 'https://gemini.google.com/app?clf=owned' }) } },
      isChatGptUrl: () => true, prepareNativeWork: lease };
    vm.createContext(context); vm.runInContext(backgroundProviderSource(source), context);
    vm.runInContext(fragment('async function leaseRedeemedCommand(command, source)', '\n// The app\'s Auto order'), context);
    expect(await context.leaseRedeemedCommand(receipt, { tab: 10, documentId: 'original-document', navigationEpoch: 0 })).toBe(true);
    expect(lease).toHaveBeenCalledWith('command:1234567890abcdef', expect.objectContaining({ id: 10 }), expect.any(Function), true);
    const current = lease.mock.calls[0]![2];
    expect(current()).toBe(true); owned = false; expect(current()).toBe(false); owned = true; now = 100; expect(current()).toBe(false);
    expect(context.commandRenderingScopes.get(receipt.id)).toEqual({ id: receipt.id, tab: 10, documentId: 'original-document', expiresAt: 100 });
  });
  it.each([
    { granted: false, attached: false, expires: false, expected: false, issue: 'permission_unavailable' },
    { granted: true, attached: false, expires: false, expected: false, issue: 'attachment_unavailable' },
    { granted: true, attached: true, expires: false, expected: true, issue: null },
    { granted: true, attached: true, expires: true, expected: false, issue: 'attachment_unavailable' }
  ])('requires permission, real attachment and the existing owner: %j', async ({ granted, attached, expires, expected, issue }) => {
    let owned = true;
    const controller = { set: vi.fn(async () => { if (expires) owned = false; }), ready: vi.fn(() => attached) };
    const context: any = { renderingIssue: null, managedBackgroundCanRender: async () => granted,
      getActiveRendering: () => controller, conversationFromUrl: () => id };
    vm.createContext(context); vm.runInContext(backgroundProviderSource(source), context);
    vm.runInContext(fragment('async function leaseNativeRendering(', '\n// The app\'s Auto order'), context);
    expect(await context.leaseNativeRendering('input:owned', { id: 10, url: `https://gemini.google.com/app/${id}` }, () => owned)).toBe(expected);
    expect(context.renderingIssue).toBe(issue);
    expect(controller.set).toHaveBeenCalledTimes(granted ? 1 : 0);
  });
});

describe('owned tab preparation never raises an OS window', () => {
  it.each(['owned', 'personal/group', 'debugger unavailable', 'changed document', 'changed route', 'changed window'])(
    'selects only the exact owned task tab once and preserves %s boundaries', async mode => {
    let owned = true;
    const tab = { id: 10, windowId: mode === 'personal/group' ? 12 : 77, url: `https://gemini.google.com/app/${id}`, active: false };
    const update = vi.fn(async (_tabId: number, _options: any) => {
      tab.active = true;
      if (mode === 'changed document') owned = false;
      if (mode === 'changed route') tab.url = `https://gemini.google.com/app/${other}`;
    });
    const state = vi.fn(async () => { if (mode === 'changed window') tab.windowId = 12; });
    const lease = vi.fn(async () => false);
    const context: any = { nativeWorkSelections: new Map(), storedBackgroundWindow: async () => ({ id: 77 }),
      setManagedWindowState: state, managedBackgroundCanRender: async () => mode === 'debugger unavailable', leaseNativeRendering: lease,
      chrome: { tabs: { get: async () => ({ ...tab }), update } } };
    vm.createContext(context); vm.runInContext(backgroundProviderSource(source), context); vm.runInContext(fragment('async function prepareNativeWork(', '\n/** Projection of a successful'), context);
    const current = () => owned;
    const result = await context.prepareNativeWork('input:existing', { ...tab }, current);
    const changed = mode.startsWith('changed');
    expect(result).toBe(!changed);
    if (!changed) {
      expect(await context.prepareNativeWork('input:existing', { ...tab }, current)).toBe(true);
      expect(update).toHaveBeenCalledTimes(mode === 'personal/group' ? 0 : 1);
      expect(state).toHaveBeenCalledTimes(mode === 'personal/group' ? 0 : 1);
    }
    expect(update.mock.calls.every(([tabId, options]) => tabId === 10 && options.active === true && !('focused' in options))).toBe(true);
    expect(lease).toHaveBeenCalledTimes(mode === 'debugger unavailable' ? 2 : 0);
  });
});

describe('background-only elected Desktop delivery', () => {
  it('never borrows an eligible old account0 chat when the selected native account is1', async () => {
    const inputId = '0eb788b8-eb40-4c91-adc2-3d183f513c6c';
    const old = { id: 10, windowId: 77, active: false, url: `https://gemini.google.com/u/0/app/${id}` };
    const selected = { id: 11, windowId: 77, active: true, url: 'https://gemini.google.com/u/1/app' };
    const probe = vi.fn(async () => ({ safe: false, navigationEpoch: 0 })), prepare = vi.fn();
    const create = vi.fn(async (url: string) => ({ id: 20, windowId: 77, active: true, url }));
    const context: any = { URL, URLSearchParams, Number, call: vi.fn(async () => ({ ok: true })), inputOpenings: {}, activeTabs: null, modelCatalogTarget: null,
      tabDocuments: { 10: 'old-document', 11: 'selected-document' }, tabEpochs: { 10: 0, 11: 0 },
      chrome: { tabs: { query: async () => [old, selected], get: async (tabId: number) => tabId === 10 ? old : selected },
        windows: { getLastFocused: async () => ({ id: 77 }) }, storage: { local: { get: async () => ({}), set: async () => {} } } },
      CHATGPT_TAB_URLS: [], cleanConversationId: () => null, conversationForTab: (tab: any) => tab.id === 10 ? id : null,
      conversationFromUrl: (value: string) => value === old.url ? id : null, ownsDocument: () => true,
      persistLive: async () => {}, inputReuseProbe: probe, prepareDesktopInputReceipt: prepare,
      createChatTab: create, protectCreatedTab: async () => {} };
    vm.createContext(context); vm.runInContext(backgroundProviderSource(source), context);
    const routing = readFileSync(new URL('../extension/gemini-routing.js', import.meta.url), 'utf8').replace('export function', 'function');
    vm.runInContext(`${routing}; geminiRouting = createGeminiRouting(chrome, async () => ({id:77}));`, context);
    vm.runInContext(fragment('async function renderElectedInput(id, source)', '\n// A read-only catalog inspection'), context);
    await context.deliverDesktopInputs([{ id: inputId }], true, [id], [inputId]);
    expect(probe).toHaveBeenCalledTimes(1); expect(probe).toHaveBeenCalledWith(11, 'selected-document');
    expect(prepare).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith(`https://gemini.google.com/u/1/app?cos-input=${inputId}#cos-input=${inputId}`, true);
  });
  it('leases a reused native document before preparation and exact-document offer without any window API', async () => {
    const inputId = '0eb788b8-eb40-4c91-adc2-3d183f513c6c', sequence: string[] = [];
    let tab: any = { id: 10, windowId: 77, url: 'https://gemini.google.com/app', active: false };
    const sendMessage = vi.fn(async () => { sequence.push('offer'); });
    const context: any = { URL, URLSearchParams, Number, call: vi.fn(async () => ({ ok: true })), geminiRouting: { resolve: async (url: string) => url, sameAccount: () => true }, activeTabs: null, inputOpenings: {}, tabDocuments: { 10: 'original-document' }, tabEpochs: { 10: 0 },
      modelCatalogTarget: null, tabReuses: {}, token: 'test-only-paired-transport', disconnected: false,
      chrome: { tabs: { query: async () => [{ ...tab }], get: async () => ({ ...tab }), sendMessage }, storage: { session: { get: async () => ({}) } } },
      CHATGPT_TAB_URLS: ['https://gemini.google.com/*'], cleanConversationId: () => null, conversationForTab: () => null, conversationFromUrl: () => null,
      ownsDocument: (owner: any) => owner?.tab === 10 && owner.documentId === 'original-document' && owner.navigationEpoch === 0,
      managedBackgroundCanRender: async () => true, isChatGptUrl: () => true, persistLive: async () => {},
      prepareNativeWork: vi.fn(async (scope: string, candidate: any, current: Function) => {
        expect(scope).toBe(`input:${inputId}`); expect(candidate.id).toBe(10); sequence.push('render'); return current();
      }), inputReuseProbe: async () => ({ safe: true, navigationEpoch: 0 }),
      prepareDesktopInputReceipt: vi.fn(async (_tab: number, claimed: string, doc: string) => {
        expect(claimed).toBe(inputId); expect(doc).toBe('original-document'); sequence.push('prepare');
        tab.url = `https://gemini.google.com/app?cos-input=${inputId}#cos-input=${inputId}`; return { ready: true };
      }) };
    vm.createContext(context); vm.runInContext(backgroundProviderSource(source), context);
    vm.runInContext(fragment('async function renderElectedInput(id, source)', '\n// A read-only catalog inspection'), context);
    await context.deliverDesktopInputs([{ id: inputId }], true, [], [inputId]);
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(sequence).toEqual(['render', 'prepare', 'render', 'offer']);
    expect(sendMessage).toHaveBeenCalledWith(10, { type: 'clf-desktop-input', id: inputId, conversationId: null }, { documentId: 'original-document' });
  });
  it.each(['?clf=6d4e359f1cea2103', '#clf=6d4e359f1cea2103', '?cos-input=7bd480b6-1234-4567-89ab-123456789abc', '#cos-input=7bd480b6-1234-4567-89ab-123456789abc'])(
    'preserves another opening marked %s instead of borrowing it', async marker => {
    const inputId = '0eb788b8-eb40-4c91-adc2-3d183f513c6c', probe = vi.fn(), prepare = vi.fn();
    const tab = { id: 10, url: `https://gemini.google.com/app${marker}` };
    const create = vi.fn(async (url: string) => ({ id: 20, url, active: true }));
    const context: any = { URL, URLSearchParams, Number, call: vi.fn(async () => ({ ok: true })), geminiRouting: { resolve: async (url: string) => url, sameAccount: () => true }, inputOpenings: {}, activeTabs: null, modelCatalogTarget: null,
      chrome: { tabs: { query: async () => [tab] } }, CHATGPT_TAB_URLS: [], cleanConversationId: () => null, conversationForTab: () => null,
      managedBackgroundCanRender: async () => true, persistLive: async () => {}, inputReuseProbe: probe,
      prepareDesktopInputReceipt: prepare, createChatTab: create, protectCreatedTab: async () => {} };
    vm.createContext(context); vm.runInContext(backgroundProviderSource(source), context);
    vm.runInContext(fragment('async function renderElectedInput(id, source)', '\n// A read-only catalog inspection'), context);
    await context.deliverDesktopInputs([{ id: inputId }], true, [], [inputId]);
    expect(probe).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith(`https://gemini.google.com/app?cos-input=${inputId}#cos-input=${inputId}`, true);
  });
  it('opens an ordinary owned chat without debugger permission', async () => {
    const inputId = '0eb788b8-eb40-4c91-adc2-3d183f513c6c';
    const create = vi.fn(async (url: string) => ({ id: 20, url, active: true }));
    const context: any = { URL, URLSearchParams, Number, call: vi.fn(async () => ({ ok: true })), geminiRouting: { resolve: async (url: string) => url, sameAccount: () => true }, inputOpenings: {}, activeTabs: null, modelCatalogTarget: null,
      chrome: { tabs: { query: async () => [] } }, CHATGPT_TAB_URLS: [], cleanConversationId: () => null, conversationForTab: () => null,
      managedBackgroundCanRender: async () => false, persistLive: async () => {}, createChatTab: create, protectCreatedTab: async () => {} };
    vm.createContext(context); vm.runInContext(backgroundProviderSource(source), context);
    vm.runInContext(fragment('async function deliverDesktopInputs(', '\n// A read-only catalog inspection'), context);
    await context.deliverDesktopInputs([{ id: inputId }], true, [], [inputId]);
    expect(create).toHaveBeenCalledWith(`https://gemini.google.com/app?cos-input=${inputId}#cos-input=${inputId}`, true);
    expect(context.inputOpenings[inputId]).toMatchObject({ tab: 20, stage: 'ready' });
  });
  it('reports a blocked Gemini route and still opens an independent ChatGPT input in the same pass', async () => {
    const blocked = '0eb788b8-eb40-4c91-adc2-3d183f513c6c', independent = '1eb788b8-eb40-4c91-adc2-3d183f513c6c';
    const create = vi.fn(async (url: string) => ({ id: 20, url, active: true })), call = vi.fn(async () => ({ ok: true }));
    const context: any = { URL, URLSearchParams, Number, call, geminiRouting: { resolve: async () => { throw new Error('gemini_account_context_required'); } },
      inputOpenings: {}, activeTabs: null, modelCatalogTarget: null, chrome: { tabs: { query: async () => [] } }, CHATGPT_TAB_URLS: [],
      cleanConversationId: () => null, conversationForTab: () => null, managedBackgroundCanRender: async () => false,
      persistLive: async () => {}, createChatTab: create, protectCreatedTab: async () => {} };
    vm.createContext(context); vm.runInContext(backgroundProviderSource(source), context);
    vm.runInContext(fragment('async function deliverDesktopInputs(', '\n// A read-only catalog inspection'), context);
    await context.deliverDesktopInputs([{ id: blocked, chatProvider: 'gemini' }, { id: independent, chatProvider: 'chatgpt' }], true, [], [blocked, independent]);
    expect(call).toHaveBeenCalledWith('/input/routing', { method: 'POST', body: JSON.stringify({ id: blocked, provider: 'gemini', issue: 'gemini_account_context_required' }) });
    expect(create).toHaveBeenCalledExactlyOnceWith(`https://chatgpt.com/?cos-input=${independent}#cos-input=${independent}`, true);
    expect(context.inputOpenings[blocked]).toBeUndefined();
    expect(context.inputOpenings[independent]).toMatchObject({ tab: 20, stage: 'ready' });
  });
  it.each(['matching election', 'changed document', 'changed election', 'changed route', 'failed lease'])(
    'retains exact input authority across the rendering wait: %s', async mode => {
    const inputId = '0eb788b8-eb40-4c91-adc2-3d183f513c6c'; let owned = true;
    const tab = { id: 10, windowId: 77, url: `https://gemini.google.com/app?cos-input=${inputId}`, active: false };
    const context: any = { inputOpenings: { [inputId]: { tab: 10 } }, tabDocuments: { 10: 'original-document' }, tabEpochs: { 10: 0 },
      ownsDocument: () => owned, isChatGptUrl: () => true, chrome: { tabs: { get: async () => ({ ...tab }), sendMessage: vi.fn(async () => ({})) } },
      prepareNativeWork: vi.fn(async () => {
        if (mode === 'changed document') owned = false;
        if (mode === 'changed election') context.inputOpenings[inputId].tab = 11;
        if (mode === 'changed route') tab.url = `https://gemini.google.com/app/${other}`;
        return mode !== 'failed lease';
      }) };
    vm.createContext(context); vm.runInContext(backgroundProviderSource(source), context);
    vm.runInContext(fragment('async function renderElectedInput(id, source)', '\nasync function deliverDesktopInputs'), context);
    expect(await context.renderElectedInput(inputId, { tab: 10, documentId: 'original-document', navigationEpoch: 0 })).toBe(mode === 'matching election');
  });
});

describe('background-only worker revival', () => {
  function revival(mode: string) {
    const entry = { id: '1234567890abcdef', conversationId: id, openingSpent: true }; let owned = true;
    const tab = { id: 10, windowId: mode === 'personal/group' ? 12 : 77, url: `https://gemini.google.com/app/${id}`, active: false };
    const context: any = { deferredRevivals: [entry], deferredRevivalOffers: new Map(), tabDocuments: { 10: 'original-document' }, tabEpochs: { 10: 0 },
      deferredRevivalId: (value: string) => value, cleanConversationId: (value: string) => value,
      conversationFromUrl: (value: string) => value.endsWith(other) ? other : id, ownsDocument: () => owned,
      chrome: { tabs: { get: async () => ({ ...tab }), sendMessage: vi.fn(async () => ({ ok: true, claimed: true })) } },
      prepareNativeWork: vi.fn(async (scope: string, candidate: any) => {
        expect(scope).toBe(`revival:${entry.id}`); expect(candidate.id).toBe(10);
        if (mode === 'changed document') owned = false;
        if (mode === 'changed route') tab.url = `https://gemini.google.com/app/${other}`;
        if (mode === 'retired command') context.deferredRevivals = [];
        return mode !== 'failed lease';
      }) };
    vm.createContext(context); vm.runInContext(backgroundProviderSource(source), context);
    vm.runInContext(fragment('async function renderDeferredRevival(entry, source)', '\nfunction deferredRevivalUrl(entry)'), context);
    return { context, entry, tab };
  }
  it.each(['owned', 'personal/group'])('dispatches an exact %s document after its real rendering lease without a window API', async mode => {
    const h = revival(mode); h.context.offerDeferredRevivalToTab(h.entry, h.tab); h.context.offerDeferredRevivalToTab(h.entry, h.tab);
    await vi.waitFor(() => expect(h.context.chrome.tabs.sendMessage).toHaveBeenCalledTimes(1));
    expect(h.context.chrome.tabs.sendMessage).toHaveBeenCalledWith(10,
      { type: 'clf-run-command', id: h.entry.id, conversationId: id, deferredRecovery: true }, { documentId: 'original-document' });
  });
  it.each(['changed document', 'changed route', 'retired command', 'failed lease'])('does not dispatch a revival after %s', async mode => {
    const h = revival(mode); h.context.offerDeferredRevivalToTab(h.entry, h.tab);
    await vi.waitFor(() => expect(h.context.deferredRevivalOffers.has(h.entry.id)).toBe(false));
    expect(h.context.chrome.tabs.sendMessage).not.toHaveBeenCalled();
  });
  it('recreates a missing revival through owned helper placement only once', async () => {
    const entry = { id: '1234567890abcdef', conversationId: id, openingSpent: false }, create = vi.fn(async () => ({ id: 10, active: true }));
    const context: any = { deferredRecoveryWork: null, deferredRevivals: [entry], commandAckOutbox: [], deferredRevivalId: (value: string) => value,
      cleanConversationId: (value: string) => value, load: async () => {}, persistLive: async () => {}, reconcileDeferredRevivalsWithApp: async () => true,
      chrome: { tabs: { query: async () => [] } }, CHATGPT_TAB_URLS: [], deferredRevivalUrl: () => 'https://gemini.google.com/app?clf=owned',
      createChatTab: create, protectCreatedTab: async () => {} };
    vm.createContext(context); vm.runInContext(backgroundProviderSource(source), context); vm.runInContext(fragment('function recoverDeferredRevivals()', '\nasync function restoreChatgptTab('), context);
    await context.recoverDeferredRevivals(); await context.recoverDeferredRevivals(); expect(create).toHaveBeenCalledTimes(1);
  });
});

describe('native model discovery election', () => {
  it.each(['settings only', 'busy app', 'preserved draft'] as const)(
    'keeps selected settings as account context, never a model composer: %s', async mode => {
    const nonce = '384c612a-cfd5-4a36-8e48-49b29fd9c2bd';
    const settings = { id: 11, windowId: 77, active: true, url: 'https://gemini.google.com/u/1/customize/connectors' };
    const tabs = [settings, ...(mode === 'settings only' ? [] : [
      { id: 10, windowId: 77, active: false, url: `https://gemini.google.com/u/1/app/${id}` }
    ])];
    const saved: any = {}, created: string[] = [], local: any = {};
    const sendMessage = vi.fn(async (_tab: number, message: any) => {
      expect(_tab).toBe(10); expect(message.type).toBe('clf-model-catalog-state');
      return { ready: false, reason: mode === 'preserved draft' ? 'draft' : 'generating' };
    });
    const context: any = { URL, Date, setTimeout, clearTimeout, connectionEpoch: 1, token: 'paired-test-only', disconnected: false,
      modelCatalogFlight: null, discardProtectedTabs: {}, commandMarkerId: () => null,
      CHATGPT_TAB_URLS: ['https://gemini.google.com/*'], call: vi.fn(async () => ({ ok: true })),
      chrome: { tabs: { query: async () => tabs, get: async (wanted: number) => tabs.find(tab => tab.id === wanted),
        update: vi.fn(async () => ({})), sendMessage }, windows: { getLastFocused: async () => ({ id: 77 }) },
        storage: { session: { get: async () => structuredClone(saved), set: async (value: any) => Object.assign(saved, structuredClone(value)) },
          local: { get: async () => structuredClone(local), set: async (value: any) => Object.assign(local, structuredClone(value)) } } }
    };
    vm.createContext(context); vm.runInContext(backgroundProviderSource(source), context);
    const routing = readFileSync(new URL('../extension/gemini-routing.js', import.meta.url), 'utf8').replace('export function', 'function');
    vm.runInContext(`${routing}; geminiRouting = createGeminiRouting(chrome, async () => ({id:77}));`, context);
    context.createChatTab = async (url: string) => { const resolved = await context.geminiRouting.resolve(url); created.push(resolved); return { id: 20, url: resolved }; };
    vm.runInContext(fragment('async function catalogProbe(', '\nlet maintenanceFlight ='), context);
    await context.inspectRequestedModels({ nonce, expiresAt: Date.now() + 10000, allowOpen: mode !== 'preserved draft' });
    expect(sendMessage).toHaveBeenCalledTimes(mode === 'settings only' ? 0 : 1);
    if (mode === 'preserved draft') {
      expect(created).toEqual([]); expect(saved.modelCatalogOwner).toBeUndefined();
      expect(context.call).toHaveBeenCalledWith('/models', expect.objectContaining({ body: JSON.stringify({ nonce, waiting: 'draft' }) }));
    } else {
      expect(created).toEqual([`https://gemini.google.com/u/1/app?cos-model-catalog=${nonce}`]);
      expect(saved.modelCatalogOwner).toEqual({ nonce, tab: 20 });
    }
    expect(local.geminiConversationPaths?.[id]).toBe(mode === 'settings only' ? undefined : `/u/1/app/${id}`);
    expect(JSON.stringify(local)).not.toContain('customize');
  });
});

describe('built-in Gemini companion login report', () => {
  const loginCode = backgroundProviderSource(source) + fragment('  const loginTab = observedTabs.find(', '\n  if (intent !== connectionEpoch');
  it.each([true, false, null])('reports the own embedded DOM answer %s instead of suppressing built-in workers', async answer => {
    const page = { id: 10, url: 'https://gemini.google.com/u/1/app', status: 'complete' };
    const read = vi.fn(async () => answer);
    const context = { URL, __cosBrowserWorker: true, observedTabs: [page], tabDocuments: { '10': 'own-document' }, tabEpochs: { '10': 2 },
      signInStage: (url: string) => url === page.url ? 'done' : null, chatGptSignedIn: read };
    expect(await vm.runInNewContext(`(async () => { ${loginCode}; return chatGptSignedInState; })()`, context)).toBe(answer);
    expect(read).toHaveBeenCalledExactlyOnceWith(10);
  });
  it.each(['document changed', 'navigation epoch changed', 'discarded', 'frozen', 'loading'])('keeps embedded login unknown for %s', async mode => {
    const page = { id: 10, url: 'https://gemini.google.com/u/1/app', status: mode === 'loading' ? 'loading' : 'complete',
      discarded: mode === 'discarded', frozen: mode === 'frozen' };
    const documents = { '10': 'own-document' }, epochs = { '10': 2 };
    const read = vi.fn(async () => {
      if (mode === 'document changed') documents['10'] = 'new-document';
      if (mode === 'navigation epoch changed') epochs['10']++;
      return true;
    });
    const context = { URL, __cosBrowserWorker: true, observedTabs: [page], tabDocuments: documents, tabEpochs: epochs,
      signInStage: () => 'done', chatGptSignedIn: read };
    expect(await vm.runInNewContext(`(async () => { ${loginCode}; return chatGptSignedInState; })()`, context)).toBeNull();
  });
});

describe('managed window never takes OS focus', () => {
  it('starts a new helper expanded and unfocused and remembers its window', async () => {
    const owned = { id: 77, type: 'normal', state: 'normal', tabs: [{ id: 10, windowId: 77, active: true }] };
    let remembered = false;
    const create = vi.fn(async () => owned), update = vi.fn(async () => ({})), remember = vi.fn(async () => { remembered = true; });
    const context: any = { geminiRouting: { resolve: async (url: string) => url }, chrome: { windows: { create, update } }, inBackgroundWindow: (work: Function) => work(),
      backgroundWindowBounds: { width: 800, height: 600 }, groupsAvailable: () => false, storedBackgroundWindow: async () => remembered ? owned : null, rememberBackgroundWindow: remember };
    vm.createContext(context); vm.runInContext(backgroundProviderSource(source), context); vm.runInContext(fragment('async function setManagedWindowState(id', '/**\n * Where background tabs go'), context);
    vm.runInContext(fragment('async function createChatTab(', '\n/**\n * Holds discard defence'), context);
    await context.createChatTab('https://gemini.google.com/app?cos-input=owned', true);
    expect(create).toHaveBeenCalledWith({ url: 'https://gemini.google.com/app?cos-input=owned', type: 'normal', state: 'normal', focused: false, width: 800, height: 600 });
    expect(remember).toHaveBeenCalledWith(77); expect(update).not.toHaveBeenCalled();
  });
  it('selects only the new helper tab within an existing expanded owned window', async () => {
    const create = vi.fn(async (options: any) => ({ id: 10, ...options })), update = vi.fn(async () => ({}));
    const context: any = { geminiRouting: { resolve: async (url: string) => url }, chrome: { tabs: { create }, windows: { update } }, inBackgroundWindow: (work: Function) => work(),
      groupsAvailable: () => false, storedBackgroundWindow: async () => ({ id: 77, type: 'normal', state: 'normal' }) };
    vm.createContext(context); vm.runInContext(backgroundProviderSource(source), context); vm.runInContext(fragment('async function setManagedWindowState(id', '/**\n * Where background tabs go'), context);
    vm.runInContext(fragment('async function createChatTab(', '\n/**\n * Holds discard defence'), context);
    await context.createChatTab('https://gemini.google.com/app', true);
    expect(create).toHaveBeenCalledWith({ url: 'https://gemini.google.com/app', windowId: 77, active: true });
    expect(update).not.toHaveBeenCalled();
  });
  it.each(['minimized', 'maximized', 'fullscreen'])(
    'retains the existing unfocused normalization of the owned %s window', async state => {
    const update = vi.fn(async () => ({}));
    const context: any = { chrome: { windows: { update } }, storedBackgroundWindow: async () => ({ id: 77, type: 'normal', state }) };
    vm.createContext(context); vm.runInContext(backgroundProviderSource(source), context); vm.runInContext(fragment('async function setManagedWindowState(id', '/**\n * Where background tabs go'), context);
    expect(await context.setManagedWindowState(77)).toBe(true);
    expect(update).toHaveBeenCalledExactlyOnceWith(77, { state: 'normal', focused: false });
  });
  it.each(['owner changed', 'operation revoked', 'window closed', 'personal popup', 'incognito'])(
    'refuses a stale presentation mutation when %s during its live window read', async mode => {
    let current = true;
    const update = vi.fn(), context: any = { chrome: { windows: { update } }, storedBackgroundWindow: async () => {
      if (mode === 'operation revoked') current = false;
      if (mode === 'window closed') throw new Error('Window closed');
      return { id: mode === 'owner changed' ? 78 : 77, type: mode === 'personal popup' ? 'popup' : 'normal',
        incognito: mode === 'incognito', state: 'minimized' };
    } };
    vm.createContext(context); vm.runInContext(backgroundProviderSource(source), context); vm.runInContext(fragment('async function setManagedWindowState(id', '/**\n * Where background tabs go'), context);
    expect(await context.setManagedWindowState(77, () => current)).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });
  it('preserves a personal inactive request and grouped placement without changing windows', async () => {
    const create = vi.fn(async () => ({ id: 10 })), grouped = vi.fn(async () => ({ id: 11, active: false }));
    const context: any = { geminiRouting: { resolve: async (url: string) => url }, chrome: { tabs: { create } }, inBackgroundWindow: (work: Function) => work(), groupsAvailable: () => true, createGroupedTab: grouped };
    vm.createContext(context); vm.runInContext(backgroundProviderSource(source), context); vm.runInContext(fragment('async function createChatTab(', '\n/**\n * Holds discard defence'), context);
    await context.createChatTab('https://gemini.google.com/app', false, false);
    expect(create).toHaveBeenCalledWith({ url: 'https://gemini.google.com/app', active: false });
    expect(await context.createChatTab('https://gemini.google.com/app', true)).toMatchObject({ id: 11, active: false });
  });
});
