/** Native rendered Claude UI adapter. No provider API, cookies or inferred task identity. */
var CLF_DOM = (() => {
  'use strict';
  const OWN = '[data-clf-root],.clf-stream,.clf-stage,.clf-composer,.clf-boot,[data-clf-user-text],#clf-control,#clf-panel';
  const TURN = '[data-testid="user-message"],[data-testid="assistant-message"]';
  const BOX = '[data-testid="chat-input"][data-cds="Editor"][contenteditable="true"][role="textbox"][aria-label="Write your prompt to Claude"]';
  const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  const nativeSuffix = new RegExp(`(?:^|_)(${UUID})$`, 'i');
  const uuid = new RegExp(`^${UUID}$`, 'i');
  const localHelper = new URL(location.href).searchParams.get('cos-helper') === 'planner';
  const all = (selector, root = document) => [...root.querySelectorAll(selector)];
  const clean = value => String(value || '').replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ').trim();
  const compact = value => clean(value).replace(/\s+/g, ' ');
  const text = node => clean(node?.innerText ?? node?.textContent);
  const shown = node => Boolean(node?.isConnected && !node.closest(`${OWN},[hidden],[aria-hidden="true"],[inert]`) &&
    node.getClientRects().length && getComputedStyle(node).display !== 'none' && getComputedStyle(node).visibility !== 'hidden');
  const enabled = node => shown(node) && !node.disabled && node.getAttribute('aria-disabled') !== 'true';
  const unique = nodes => { const found = [...new Set(nodes)].filter(shown); return found.length === 1 ? found[0] : null; };
  const safe = (read, fallback = null) => { try { return read() ?? fallback; } catch { return fallback; } };
  const captureUserImages = typeof CLF_USER_IMAGE_CAPTURE === 'undefined' ? () => [] :
    CLF_USER_IMAGE_CAPTURE.create('onecode-claude-user-image');
  function userImages(root) {
    const owner = root.closest('[data-cds="UserMessage"][data-turn-key]');
    // Claude renders sent image tiles beside the bubble. Join that strip only
    // when its native turn key is the exact UUID already proved by the bubble.
    const ownStrip = owner?.getAttribute('data-turn-key')?.toLowerCase() === nativeSuffix.exec(root.id)?.[1]?.toLowerCase() &&
      owner?.querySelectorAll('[data-testid="user-message"]').length === 1
      ? all(':scope > [data-cds="MessageAttachments"] [data-cds="MessageAttachmentsImage"] img[data-cds-tile-picture]', owner) : [];
    return captureUserImages([...new Set([...all('img', root), ...ownStrip])].filter(image =>
      shown(image) && (image.currentSrc || image.src) && !image.closest('[role="toolbar"], [data-cds="TurnStatus"]')
    ));
  }

  const isAppHomePath = path => /^\/new\/?$/.test(path);
  const conversationFromPath = path => {
    const native = new RegExp(`^/chat/(${UUID})/?$`, 'i').exec(path)?.[1];
    return native ? `claude:${native.toLowerCase()}` : null;
  };
  const conversationId = () => location.origin === 'https://claude.ai' ? conversationFromPath(location.pathname) : null;
  const nativeMessageIdValid = (id, role, conversation = conversationId()) => typeof id === 'string' && typeof conversation === 'string' &&
    ['user', 'assistant'].includes(role) && id.startsWith(`${conversation}:${role}:`) && uuid.test(id.slice(`${conversation}:${role}:`.length));
  const nativeUserIdValid = (id, conversation = conversationId()) => nativeMessageIdValid(id, 'user', conversation);
  const composer = () => unique(all(BOX));
  const composerWritable = () => enabled(composer()) && composer().getAttribute('contenteditable') === 'true';
  const sendButton = () => unique(all('button[data-testid="chat-input-send"][aria-label="Send message"]'));
  const queuedSendButtons = () => all('button,[role="button"]').filter(node => shown(node) &&
    compact(node.getAttribute('aria-label') || text(node)).toLowerCase() === 'send now');
  const attachButton = () => unique(all('button[data-testid="chat-input-attach"][aria-label="Add files, connectors, and more"]'));
  const composerBox = () => composer()?.closest('form') || composer()?.parentElement?.parentElement || null;
  function blockText(node) {
    if (!node) return '';
    const read = value => {
      if (value.nodeType === Node.TEXT_NODE) return value.textContent || '';
      if (value.nodeType !== Node.ELEMENT_NODE) return '';
      if (value.matches('script,style,button,[hidden],[aria-hidden="true"]')) return '';
      if (value.localName === 'br') return '\n';
      const body = [...value.childNodes].map(read).join('');
      return body + (/^(?:p|div|li|pre|h[1-6]|blockquote)$/.test(value.localName) && body !== '\n' ? '\n' : '');
    };
    return clean(read(node));
  }
  const nativeSkillSelections = new WeakMap();
  let activeNativeSkill = null;
  const acceptedSkillQuestions = new Map();
  let outgoingSkill = null;
  const skillChipSelector = 'span.react-renderer.node-skillChip[data-skill-id="onecode"][contenteditable="false"]';
  const sentSkillGroup = ':scope > p.whitespace-pre-wrap > span[class~="group/chip"]';
  function skillBody(box, token) {
    const copy = box.cloneNode(true), candidates = all(skillChipSelector, box), index = candidates.indexOf(token);
    if (index < 0) return null; all(skillChipSelector, copy)[index]?.remove(); return blockText(copy);
  }
  function skillSelection(box = composer()) {
    const proof = box && (nativeSkillSelections.get(box) || activeNativeSkill);
    if (!proof || proof.revoked || proof.route !== location.href || !proof.current() || composer() !== box ||
        document.querySelector('button[data-testid="user-menu-button"]') !== proof.account) return null;
    const tokens = all('span.react-renderer.node-skillChip[data-skill-id]', box);
    const token = tokens.length === 1 ? tokens[0] : null;
    if (!token?.matches(skillChipSelector) || !shown(token) || compact(token.textContent) !== '/onecode' ||
        all('[data-node-view-wrapper][contenteditable="false"]', token).length !== 1) return null;
    const leading = document.createRange(); leading.selectNodeContents(box); leading.setEndBefore(token);
    if (compact(leading.toString())) return null;
    if (token !== proof.token || box !== proof.box) {
      // ProseMirror can replace the chip or editor after accepting insertText.
      // Only the original positive selection, unchanged question set and exact
      // frozen body can carry that proof across its native render.
      if (proof.expected === null || skillBody(box, token) !== proof.expected ||
          nativeQuestionKey() !== proof.questions) return null;
      proof.token = token; proof.box = box; nativeSkillSelections.set(box, proof);
    }
    return proof;
  }
  const composerAuthoredText = () => {
    const box = composer(), proof = skillSelection(box);
    if (proof) return skillBody(box, proof.token) ?? blockText(box);
    // A failed upload may retain its native chip after the preparation lease
    // was disposed. Read its intact framed body for a later human Send, without
    // treating that presentation as proof the skill was selected for a new task.
    const tokens = box ? all(skillChipSelector, box) : [], token = tokens.length === 1 ? tokens[0] : null;
    if (token && shown(token) && compact(token.textContent) === '/onecode' &&
        all('[data-node-view-wrapper][contenteditable="false"]', token).length === 1) {
      const leading = document.createRange(); leading.selectNodeContents(box); leading.setEndBefore(token);
      const body = skillBody(box, token);
      if (!compact(leading.toString()) && body !== null && userPromptText(body) !== null) return body;
    }
    return blockText(box);
  };
  function userPromptText(value) {
    if (typeof value !== 'string') return null;
    const marker = /^\[\[CLF-(?:HANDOFF|RESUME):[A-Za-z0-9_-]{16,64}\]\]\n\n/.exec(value)?.[0] || '';
    const frame = /^\[\[COS_CONTEXT:(\d{1,6})\]\]\n/.exec(value.slice(marker.length));
    if (!frame) return null;
    const end = marker.length + frame[0].length + Number(frame[1]);
    const boundary = '\n[[/COS_CONTEXT]]\n\n';
    return value.startsWith(boundary, end) ? marker + value.slice(end + boundary.length) : null;
  }
  function turnIdOf(node) {
    const root = node?.matches?.(TURN) ? node : node?.closest?.(TURN);
    const conversation = conversationId();
    if (!root || !conversation || root.closest(OWN)) return null;
    const native = nativeSuffix.exec(root.id || '')?.[1]?.toLowerCase();
    if (!native) return null;
    const role = root.getAttribute('data-testid') === 'user-message' ? 'user' : 'assistant';
    if (role === 'assistant' && root.getAttribute('data-turn-key')?.toLowerCase() !== native) return null;
    return `${conversation}:${role}:${native}`;
  }
  const messageIdOf = node => turnIdOf(node);
  const turns = () => safe(() => {
    const rows = all(TURN).filter(shown).filter(node => !node.parentElement?.closest(TURN)).map(node => ({ node, nodes: [node],
      role: node.getAttribute('data-testid') === 'user-message' ? 'user' : 'assistant', id: turnIdOf(node) })).filter(row => row.id);
    const counts = new Map(); for (const row of rows) counts.set(row.id, (counts.get(row.id) || 0) + 1);
    return rows.filter(row => counts.get(row.id) === 1);
  }, []);
  // Delayed text extraction must not change the identity of a mounted question.
  const nativeQuestionKey = () => turns().filter(row => row.role === 'user').map(row => row.id).join('\u0000');
  const proseNodes = root => all('[data-cds="Prose"]', root).filter(node => !node.parentElement?.closest('[data-cds="Prose"]') &&
    !node.closest('[data-cds="TurnStatus"],[data-find-omitted],button') && shown(node));
  const richMessageNodes = message => message.role === 'assistant' && message.node?.isConnected &&
    turnIdOf(message.node) === message.id ? proseNodes(message.node) : [];
  function messagesIn(turn, _index = 0, seen = new Set()) {
    if (!turn?.node?.isConnected || !turn.id || turn.id !== turnIdOf(turn.node) || seen.has(turn.id)) return [];
    const images = turn.role === 'user' ? userImages(turn.node) : [];
    let value;
    if (turn.role === 'user') {
      const authored = all(':scope > div.contents', turn.node);
      if (!authored.length && !images.length) return [];
      value = userAuthoredText(authored.length === 1 ? authored[0] : null, turn.node, turn.id);
    }
    else {
      const parts = proseNodes(turn.node).map(node => {
        const copy = node.cloneNode(true);
        for (const drop of copy.querySelectorAll(`${OWN},button,script,style,[data-cds="TurnStatus"],[data-find-omitted],[role="toolbar"]`)) drop.remove();
        return typeof CLF_GEMINI_MARKDOWN !== 'undefined' ? CLF_GEMINI_MARKDOWN.render(copy) : blockText(copy);
      });
      value = parts.filter(Boolean).join('\n\n');
    }
    // Image-only user sends have no text worth returning, but the row is
    // still a real authored message once its pixels are captured.
    if (!value && !images.length) return [];
    seen.add(turn.id);
    // Full user readback stays private evidence for the durable exact task receipt.
    // Only userPromptText removes its app frame in presentation.
    return [{ id: turn.id, role: turn.role, text: value, turnId: turn.id, node: turn.node, interrupted: false,
      ...(images.length ? { images } : {}) }];
  }
  const messages = () => { const seen = new Set(); return turns().flatMap((turn, at) => messagesIn(turn, at, seen)); };
  const nativeUserText = new WeakMap();
  let nativeUserReceiptRead = null;
  function nativeUserBody(node, id) {
    const route = location.pathname, signature = node.innerHTML;
    if (!node.isConnected || turnIdOf(node) !== id) return null;
    let state = nativeUserText.get(node);
    if (state?.route !== route || state?.signature !== signature) {
      clearTimeout(state?.retry);
      state = { route, signature, attempts: 0, pending: false, text: null, last: 0, until: Date.now() + 30000, retry: null };
      nativeUserText.set(node, state);
    }
    const receipt = nativeUserReceiptRead;
    if (receipt && !receipt.prior.has(id) && receipt.current()) state.until = Math.max(state.until, receipt.until);
    if (state.text !== null) return state.text;
    if (state.pending || Date.now() >= state.until || Date.now() - state.last < 250) return null;
    clearTimeout(state.retry); state.retry = null;
    state.pending = true; state.attempts++; state.last = Date.now();
    const diagnostic = stage => { try { node.setAttribute('data-onecode-claude-user-read-diagnostic', JSON.stringify({ stage, attempts: state.attempts })); } catch { /* Fixed read-only counters. */ } };
    diagnostic('reading');
    const nonce = crypto.randomUUID(), native = nativeSuffix.exec(node.id || '')?.[1]?.toLowerCase();
    let timer;
    const finish = value => {
      clearTimeout(timer); window.removeEventListener('message', receive); state.pending = false;
      if (!node.isConnected || location.pathname !== route || turnIdOf(node) !== id || node.innerHTML !== signature || nativeUserText.get(node) !== state) return;
      if (value === null) {
        // React's public turn props can hydrate without changing its already
        // mounted HTML. A few early reads must not permanently retire that row.
        const delay = Math.min(2000, 250 * 2 ** Math.min(state.attempts - 1, 3));
        if (Date.now() + delay < state.until) { diagnostic('waiting-for-source'); state.retry = setTimeout(() => nativeUserBody(node, id), delay); }
        else diagnostic('source-deadline');
        return;
      }
      state.text = value;
      diagnostic('ready');
      document.dispatchEvent(new Event('onecode-claude-user-ready'));
    };
    const receive = event => {
      if (event.source !== window || event.origin !== location.origin || event.data?.type !== 'onecode-claude-user-read-result' || event.data.nonce !== nonce) return;
      const proof = event.data.user;
      finish(event.data.path === route && proof && `claude:${proof.conversation}` === conversationId() && proof.message === native &&
        uuid.test(proof.token || '') && node.getAttribute('data-clf-claude-user-token') === proof.token &&
        typeof proof.text === 'string' && proof.text.length > 0 && proof.text.length <= 240000 ? clean(proof.text) : null);
    };
    window.addEventListener('message', receive); timer = setTimeout(() => finish(null), 2000);
    window.postMessage({ type: 'onecode-claude-user-read', nonce, message: native }, location.origin);
    return null;
  }
  const witnessedUserBodies = new WeakMap();
  function userAuthoredText(root, node, id) {
    const source = nativeUserBody(node, id);
    const witness = witnessedUserBodies.get(node);
    if (source === null && witness?.id === id && witness.html === node.innerHTML) return witness.text;
    const raw = source ?? blockText(root);
    // Collapsed native Markdown loses blank lines and hides the slash glyph.
    // Do not journal that lossy app frame as a second authored user message
    // while its exact public plain source is still hydrating.
    const displayFrame = raw.replace(/^\/?onecode\s+/, '');
    const lossyFrame = source === null && /^\[\[COS_CONTEXT:\d{1,6}\]\]/.test(displayFrame) &&
      (displayFrame !== raw || userPromptText(displayFrame) === null);
    const accepted = acceptedSkillQuestions.get(id);
    const outgoing = outgoingSkill && outgoingSkill.current() && !outgoingSkill.prior.has(id) &&
      (!outgoingSkill.conversation || id.startsWith(`${outgoingSkill.conversation}:user:`)) ? outgoingSkill : null;
    // A long native question can collapse its selected skill chip out of the
    // rendered body. The exact plain source plus our positively selected
    // outgoing skill still proves its prefix; a DOM chip is not required again.
    const authoredSource = source?.startsWith('/onecode ') ? source.slice('/onecode '.length) : null;
    if (authoredSource !== null && (accepted && authoredSource === accepted || outgoing && authoredSource === outgoing.expected)) {
      if (outgoing) { acceptedSkillQuestions.set(id, authoredSource); if (acceptedSkillQuestions.size > 512) acceptedSkillQuestions.delete(acceptedSkillQuestions.keys().next().value); }
      return authoredSource;
    }
    const chips = (root ? all(sentSkillGroup, root) : []).filter(wrapper => {
      const buttons = all(':scope > span[role="button"][type="button"][data-base-ui-click-trigger][aria-haspopup="dialog"]', wrapper)
        .filter(node => ['0', '-1'].includes(node.getAttribute('tabindex')));
      if (buttons.length !== 1 || compact(buttons[0].textContent) !== '/onecode') return false;
      const slash = all('span[aria-hidden="true"]', buttons[0]).filter(node => compact(node.textContent) === '/');
      if (slash.length !== 1) return false;
      const range = document.createRange(); range.selectNodeContents(root); range.setEndBefore(wrapper);
      return !compact(range.toString());
    });
    const restoreFramedBody = candidate => {
      const receipt = nativeUserReceiptRead;
      if (!receipt || receipt.prior.has(id) || !receipt.current() || userPromptText(receipt.submitted) === null ||
          candidate.replace(/\s+/g, '') !== receipt.submitted.replace(/\s+/g, '')) return null;
      return receipt.submitted;
    };
    if (chips.length !== 1) return restoreFramedBody(raw) ?? (lossyFrame ? '' : raw);
    const copy = root.cloneNode(true), allGroups = all(sentSkillGroup, root);
    all(sentSkillGroup, copy)[allGroups.indexOf(chips[0])]?.remove();
    const candidate = blockText(copy);
    // After reload the outgoing lease is gone. The exact native chip plus its
    // public plain source still lets presentation remove the transport prefix.
    // This does not select a skill, authorize Send or manufacture an ACK.
    if (authoredSource !== null && userPromptText(authoredSource) !== null && compact(candidate) === compact(authoredSource)) return authoredSource;
    if (accepted && candidate === accepted || outgoing && candidate === outgoing.expected) {
      if (outgoing) { acceptedSkillQuestions.set(id, candidate); if (acceptedSkillQuestions.size > 512) acceptedSkillQuestions.delete(acceptedSkillQuestions.keys().next().value); }
      return candidate;
    }
    // Reloaded historical presentation can recognize the same native chip and
    // an intact app frame. This never marks a skill selected or authorizes Send.
    return source ?? restoreFramedBody(candidate) ?? (userPromptText(candidate) !== null ? candidate : lossyFrame ? '' : raw);
  }
  function waitFor(read, current, timeout = 15000) {
    return new Promise(resolve => {
      let done = false, scheduled = null;
      const finish = value => { if (done) return; done = true; observer.disconnect(); clearTimeout(timer); clearInterval(tick); if (scheduled !== null) clearTimeout(scheduled); resolve(value); };
      const check = () => { if (!current()) return finish(null); try { const value = read(); if (value) finish(value); } catch { finish(null); } };
      const observer = new MutationObserver(() => { if (scheduled === null) scheduled = setTimeout(() => { scheduled = null; check(); }, 0); });
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      const timer = setTimeout(() => finish(null), Math.max(1, timeout)), tick = setInterval(check, 200); check();
    });
  }
  function editPrompt(value, mode = false, failure = null, preserveSkill = true) {
    return safe(() => {
      const box = composer(); if (!box || !composerWritable()) { failure?.('editor-not-writable'); return false; }
      const prior = composerAuthoredText(), wanted = clean(value);
      if (prior && mode !== true && mode !== 'append' && prior !== wanted) { failure?.('existing-draft'); return false; }
      const next = mode === 'append' ? prior + String(value) : String(value);
      if (prior === clean(next) && (preserveSkill || !skillSelection(box))) return true;
      box.focus(); const selection = document.getSelection(), range = document.createRange();
      range.selectNodeContents(box);
      const skill = preserveSkill && skillSelection(box); if (skill) range.setStartAfter(skill.token);
      selection.removeAllRanges(); selection.addRange(range);
      if (skill) { skill.expected = clean(next); skill.editing = true; }
      try { document.execCommand?.('insertText', false, next); }
      finally { if (skill) skill.editing = false; }
      // Do not manufacture a native editor document by setting textContent.
      // ProseMirror must accept the editor-native edit and expose its full readback.
      const applied = composer() === box && composerAuthoredText() === clean(next);
      if (applied && !preserveSkill) nativeSkillSelections.get(box)?.dispose();
      return applied;
    }, false);
  }
  const insertPrompt = (value, mode = false, failure = null) => editPrompt(value, mode, failure);
  const clearPromptExact = expected => composerAuthoredText() === clean(expected) && editPrompt('', true, null, false);
  function captureComposerDraft(expected, current = () => true) {
    let box = composer(), retired = false, attached = null;
    const text = clean(expected);
    const selectedSkill = skillSelection(box);
    const owns = () => {
      if (retired || !current()) return false;
      const next = composer();
      // A selected skill has its own stronger native-render continuity proof.
      // Carry only that exact proof across a host replacement, including Goal
      // and command drafts; ordinary and human-authored drafts stay node-bound.
      if (next !== box && selectedSkill && skillSelection(next) === selectedSkill && composerAuthoredText() === text) box = next;
      return next === box && box?.isConnected && composerAuthoredText() === text &&
        (!attached || ownsAttachments(attached));
    };
    return { text, current: owns, clear: async () => owns() && clearPromptExact(expected), withdraw: () => { if (!owns()) return false; retired = true; return true; },
      dispose: () => { retired = true; }, attachments: (nodes, names, pastedAt) => { attached = { nodes, names, pastedAt, previews: nodes.map(blobPreview) }; },
      rebind: () => {
        if (retired || !current() || composerAuthoredText() !== text || (attached && !ownsAttachments(attached))) return false;
        box = composer();
        return Boolean(box);
      } };
  }
  async function prepareNativeSkill(name, current = () => true) {
    const noteStage = stage => { try { document.documentElement.setAttribute('data-onecode-claude-skill-diagnostic', JSON.stringify({ stage,
      composers: all(BOX).filter(shown).length, chips: composer() ? all(skillChipSelector, composer()).length : 0,
      slashMenus: all('[data-cds-portal] [role="menu"][data-positioning="native-anchor"]').filter(shown).length })); } catch { /* Fixed native-state flags only. */ } };
    const unavailable = stage => { noteStage(stage); return { selected: false }; };
    if (name !== 'onecode' || !current()) return unavailable('operation-unavailable');
    const box = composer(), route = location.href, conversation = conversationId();
    if (!box || !composerWritable()) return unavailable('editor-unavailable');
    if (composerAuthoredText() || hasComposerAttachments() || all(skillChipSelector, box).length) return unavailable('composer-not-empty');
    const questions = nativeQuestionKey();
    let interrupted = false, performing = false, success = false;
    const act = run => { performing = true; try { return run(); } finally { performing = false; } };
    const note = event => { if (event.isTrusted && !performing) interrupted = true; };
    const owns = () => !interrupted && current() && location.href === route && conversationId() === conversation && composer() === box && box.isConnected &&
      !hasComposerAttachments() && nativeQuestionKey() === questions;
    const slashMenu = () => unique(all('[data-cds-portal] [role="menu"][data-positioning="native-anchor"]').filter(menu =>
      menu.style.getPropertyValue('position-anchor') === '--slash-command-menu' || menu.style.positionAnchor === '--slash-command-menu'));
    for (const type of ['pointerdown', 'keydown', 'beforeinput', 'input']) document.addEventListener(type, note, true);
    try {
      if (all('[role="menu"]').some(shown)) return unavailable('native-menu-open');
      if (!act(() => insertPrompt('/', true))) return unavailable('slash-insertion-failed');
      const searching = () => owns() && composerAuthoredText() === '/';
      const menu = await waitFor(slashMenu, searching, 2500); if (!menu) return unavailable('slash-menu-unavailable');
      const row = await waitFor(() => unique(all('[role="menuitem"]', menu).filter(item => item.closest('[role="menu"]') === menu &&
        enabled(item) && leadingName(item) === name)), searching, 2000);
      if (!row || !searching()) return unavailable('skill-row-unavailable');
      act(() => row.click());
      const token = await waitFor(() => {
        const candidates = all(skillChipSelector, box).filter(node => shown(node) && compact(node.textContent) === '/onecode' &&
          all('[data-node-view-wrapper][contenteditable="false"]', node).length === 1);
        return candidates.length === 1 ? candidates[0] : null;
      }, owns, 2500);
      if (!token || !owns()) return unavailable('skill-token-unconfirmed');
      const proof = { name, token, box, route, questions, current, expected: '', revoked: false, editing: false,
        account: document.querySelector('button[data-testid="user-menu-button"]') };
      const editTypes = ['beforeinput', 'input', 'keydown', 'pointerdown'];
      const noteEdit = event => { if (!proof.editing && event.isTrusted && event.target?.closest?.(BOX)) proof.dispose(); };
      proof.dispose = () => {
        proof.revoked = true;
        for (const type of editTypes) document.removeEventListener(type, noteEdit, true);
        nativeSkillSelections.delete(proof.box);
        if (activeNativeSkill === proof) activeNativeSkill = null;
      };
      activeNativeSkill?.dispose();
      activeNativeSkill = proof;
      for (const type of editTypes) document.addEventListener(type, noteEdit, true);
      nativeSkillSelections.set(box, proof);
      if (composerAuthoredText()) { proof.dispose(); return unavailable('selected-draft-changed'); }
      success = true;
      noteStage('selected');
      return { selected: true, current: () => skillSelection() === proof, dispose: proof.dispose };
    } finally {
      if (!success && owns() && !all(skillChipSelector, box).length) {
        const residue = composerAuthoredText();
        if (residue === '/' || residue === '/onecode') act(() => clearPromptExact(residue));
      }
      for (const type of ['pointerdown', 'keydown', 'beforeinput', 'input']) document.removeEventListener(type, note, true);
    }
  }
  let ownNames = [], ownApps = [];
  const connectorNames = () => [...ownNames];
  const setConnectorNames = names => { const next = [names?.core, names?.desktop, names?.plugins].filter(name => typeof name === 'string' && name.length > 0 && name.length <= 160);
    if (!next.length) return false; ownNames = [...new Set(next)]; return true; };
  const setConnectorApps = value => { ownApps = Object.entries(value || {}).flatMap(([surface, entries]) => (Array.isArray(entries) ? entries : [])
    .filter(entry => typeof entry?.appId === 'string').map(entry => ({ ...entry, surface }))); return true; };
  const connectorApps = () => ownApps.map(row => ({ ...row }));
  // Native controls are deliberately isolated below. A provider redesign leaves
  // a recoverable pre-Send refusal, never an unproven connector or repeated Send.
  const stopButton = () => unique(all('button[aria-label="Stop response"]'));
  const approvalCard = () => null;
  const approvalWaiting = () => Boolean(approvalCard());
  const generating = () => Boolean(stopButton()) || approvalWaiting() || turns().filter(row => row.role === 'assistant').at(-1)?.node.getAttribute('data-is-streaming') === 'true';
  const stopGeneration = current => { const button = stopButton(); if (!current() || !enabled(button)) return false; button.click(); return true; };
  function attachmentRows() {
    const tile = '[data-testid="file-thumbnail"]:is([data-cds-attachment], [data-cds="MessageAttachmentsImage"])';
    const box = composer(), dock = box?.closest('[data-cds-dock-group]');
    const form = box?.closest('form'), owner = dock || form;
    if (!owner) return [];
    // Current Claude renders the strip beside the editor's form, inside the
    // same dock. Only count tiles in the dock that owns the active composer.
    return all(`[data-cds-composer-attachments] ${tile}, [data-cds="MessageAttachments"][data-cds-composer-attachments-row] > ${tile}`, owner)
      .filter(row => {
        const rowForm = row.closest('form');
        return shown(row) && !row.closest('[data-cds="UserMessage"],[data-testid="user-message"]') &&
          (!rowForm || rowForm === form) && (!dock || row.closest('[data-cds-dock-group]') === dock);
      });
  }
  const attachmentRemove = row => {
    const controls = all('button[data-cds-attachment-remove][aria-label^="Remove "]', row);
    return controls.length === 1 ? controls[0] : null;
  };
  const attachmentName = row => {
    const label = attachmentRemove(row)?.getAttribute('aria-label');
    return label && label.startsWith('Remove ') && label.length > 7 && label.length <= 519 ? label.slice(7) : null;
  };
  function attachmentsMatch(rows, names, pastedAt) {
    if (rows.length !== names.length) return false;
    const unmatched = names.slice();
    return rows.every(row => {
      const name = attachmentName(row);
      if (!name) return true; // A staged tile can acquire its native label while uploading.
      let index = unmatched.indexOf(name);
      if (index < 0 && pastedAt !== undefined) {
        // Claude adds its paste timestamp to a clipboard File's name.
        const renamed = /^(\d{13})_(.+)$/s.exec(name);
        const timestamp = Number(renamed?.[1]);
        if (renamed && timestamp >= pastedAt && timestamp <= pastedAt + 15000) index = unmatched.indexOf(renamed[2]);
      }
      if (index < 0) return false;
      unmatched.splice(index, 1);
      return true;
    });
  }
  function blobPreview(row) {
    const image = row.querySelector('img[data-cds-tile-picture]');
    const url = image?.src || image?.currentSrc;
    return url?.startsWith('blob:') ? url : null;
  }
  function ownsAttachments({ nodes, names, pastedAt, previews }) {
    const rows = attachmentRows();
    if (!attachmentsMatch(rows, names, pastedAt)) return false;
    const remaining = new Set(rows);
    return nodes.every((node, index) => {
      const preview = previews[index], observed = blobPreview(node);
      const match = remaining.has(node) && (!preview || !observed || observed === preview) ? node :
        preview && [...remaining].find(row => blobPreview(row) === preview);
      if (!match) return false;
      remaining.delete(match);
      previews[index] ??= blobPreview(match);
      return true;
    });
  }
  const hasComposerAttachments = () => attachmentRows().length > 0;
  const composerAttachmentNames = () => attachmentRows().map(attachmentName).filter(Boolean).sort();
  function leadingName(node) {
    let budget = 128;
    const read = (value, depth) => {
      if (!value || depth > 12 || --budget < 0) return '';
      if (value.nodeType === Node.TEXT_NODE) return compact(value.textContent);
      if (value.nodeType !== Node.ELEMENT_NODE || value.matches('svg,[data-cds="Icon"],[hidden],[aria-hidden="true"],[inert]')) return '';
      for (const child of value.childNodes) { const label = read(child, depth + 1); if (label) return label; }
      return '';
    };
    return read(node, 0);
  }
  async function uploadImages(images = [], current = () => true, draft = null, extraFiles = [], { explain } = {}) {
    const refuse = reason => { explain?.(reason); return false; };
    const files = [...extraFiles];
    try {
      for (const image of images || []) {
        const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-zA-Z0-9+/=]+)$/.exec(image.dataUrl || '');
        if (!match) return refuse('upload-file-invalid');
        files.push(new File([Uint8Array.from(atob(match[2]), value => value.charCodeAt(0))], image.name || 'image.png', { type: match[1] }));
      }
    } catch { return refuse('upload-file-invalid'); }
    if (!files.length) return true;
    let box = composer(); const route = location.href, expected = composerAuthoredText();
    if (files.length > 20 || files.some(file => !file.name || file.name.length > 512) || !box || !composerWritable() ||
        !current() || !draft?.current() || hasComposerAttachments()) return refuse('upload-draft-unavailable');
    const paste = files.every(file => /^image\//i.test(file.type));
    const form = box.closest('form');
    const dock = box.closest('[data-cds-dock-group]') || form;
    if (!dock) return refuse('upload-draft-unavailable');
    let input = null;
    if (!paste) {
      // Non-image files keep the existing native file input route.
      for (const owner of new Set([form, dock])) {
        if (!owner) continue;
        const inputs = all('input[type="file"][data-testid="file-upload"][aria-label="Upload files"][multiple]', owner)
          .filter(node => node.isConnected && !node.disabled && !node.closest(OWN) &&
            (!node.closest('form') || node.closest('form') === form));
        if (inputs.length > 1) return refuse('upload-input-ambiguous');
        if (inputs.length === 1) { input = inputs[0]; break; }
      }
      if (!input) return refuse('upload-input-unavailable');
    }
    let interrupted = false;
    const note = event => {
      if (!event.isTrusted) return;
      const button = event.target?.closest?.('button');
      if (dock.contains(event.target) ||
          event.target?.closest?.(`${BOX},[data-cds-composer-attachments],[data-cds-composer-attachments-row],input[type="file"]`) ||
          button && (button === sendButton() || button === attachButton())) interrupted = true;
    };
    const survives = () => !interrupted && current() && location.href === route;
    const owns = () => {
      if (!survives()) return false;
      const next = composer();
      if (next !== box) {
        // Recheck the original text and draft lease after each native render.
        // The single upload event remains spent across these read-only checks.
        if (!next?.isConnected || !draft.rebind?.()) return false;
        box = next;
      }
      return Boolean(box?.isConnected && draft.current());
    };
    const priorAlerts = new Set(errors().map(error => error.node));
    const editEvents = ['beforeinput', 'input', 'change', 'paste', 'drop', 'pointerdown', 'keydown', 'click'];
    for (const type of editEvents) document.addEventListener(type, note, true);
    try {
      if (!owns()) return refuse('upload-draft-changed');
      const transfer = new DataTransfer(); for (const file of files) transfer.items.add(file);
      // Dispatch exactly one native paste or file change for the owned draft.
      const pastedAt = paste ? Date.now() : undefined;
      if (paste) box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true, composed: true }));
      else { input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true })); }
      const names = files.map(file => file.name);
      const staged = await waitFor(() => {
        if (!owns()) return composer() === box && composerAuthoredText() !== expected ? { error: 'upload-draft-changed' } : null;
        if (errors().some(error => !priorAlerts.has(error.node))) return { error: 'native-upload-error' };
        const rows = attachmentRows();
        if (rows.length > files.length) return { error: 'upload-attachment-mismatch' };
        return attachmentsMatch(rows, names, pastedAt) ? { rows } : null;
      }, survives);
      if (!staged?.rows || !owns()) return refuse(staged?.error || (!survives() ? 'upload-draft-changed' : paste ? 'paste-not-staged' : 'upload-not-staged'));
      // Native Send owns the timing of upload completion. Lease the staged
      // tiles now and let send() use the first enabled provider Send button.
      draft.attachments(staged.rows, names, pastedAt);
      return draft.current();
    } catch { return refuse(paste ? 'native-paste-unavailable' : 'native-upload-unavailable'); }
    finally { for (const type of editEvents) document.removeEventListener(type, note, true); }
  }
  function usageEvidence(node, notice) {
    const exhausted = /\b(?:reached|hit|exceeded) (?:your |the )?(?:(?:usage|message|session|weekly) ){0,3}limit\b|\b(?:usage|message|session|weekly) limit (?:reached|exceeded)\b|\bout of (?:messages|usage)\b/i.test(notice);
    if (!exhausted) return null;
    const kind = /\bweek(?:ly)?\b/i.test(notice) ? 'weekly' : /\bsession\b/i.test(notice) ? 'session' : 'unknown';
    const resetText = /\b((?:(?:your |the )?(?:(?:usage|message|session|weekly) )?limit (?:will )?)?resets?\b[\s\S]{0,240}|(?:you can )?try again\b[\s\S]{0,240}|(?:messages?|usage) (?:will be |are )?available again\b[\s\S]{0,240})/i.exec(notice)?.[1]?.trim();
    const times = all('time[datetime]', node).map(row => row.getAttribute('datetime')).filter(value => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value || ''))
      .map(value => Date.parse(value)).filter(value => Number.isFinite(value) && value > 0);
    return { kind, ...(resetText ? { resetText } : {}), ...(times.length === 1 ? { resetAt: times[0] } : {}) };
  }
  const errors = () => all('[role="alert"],[role="alertdialog"]').filter(node => shown(node) && !node.closest(`[data-testid="user-message"],[data-cds="Prose"],${OWN}`) &&
    !node.parentElement?.closest('[role="alert"],[role="alertdialog"]')).map(node => {
    const notice = compact(text(node)).slice(0, 2000), usageLimit = usageEvidence(node, notice);
    const recoverable = !usageLimit && /^(?:something went wrong|network error|connection (?:lost|interrupted)|unable to connect|there was an error)[.!]?$/i.test(notice);
    return { node, text: notice, recoverable, blocking: !recoverable, ...(usageLimit ? { usageLimit } : {}) };
  }).filter(row => row.text);
  function messageComplete(message) {
    const node = message?.node;
    return Boolean(node?.isConnected && node.matches('[data-testid="assistant-message"]') && turnIdOf(node) &&
      node.getAttribute('data-is-streaming') === 'false' && all('[data-testid="message-actions"][data-cds="MessageActions"][role="toolbar"]', node).length === 1 &&
      !generating() && !errors().some(error => error.blocking));
  }
  function completedResponseReceipt(allowStaleStop = false) {
    const rows = messages(), question = rows.findLast(row => row.role === 'user'), answer = rows.at(-1);
    if (!question || answer?.role !== 'assistant' || !nativeUserIdValid(question.id) || !messageComplete(answer) ||
        (!allowStaleStop && generating())) return null;
    return { provider: 'claude', conversationId: conversationId(), questionId: question.id, messageId: answer.id, text: answer.text };
  }
  const recoveryTerminalReceipt = questionId => { const receipt = completedResponseReceipt(); return receipt?.questionId === questionId ? { ...receipt, outcome: 'complete' } : null; };
  const safeOutputPath = value => typeof value === 'string' && value.length <= 600 && value.startsWith('/mnt/user-data/outputs/') &&
    !/[\\\u0000-\u001f\u007f?#]/.test(value) && value.slice('/mnt/user-data/outputs/'.length).split('/').every(part => part && part !== '.' && part !== '..');
  const fileCardNode = card => {
    if (!card || !uuid.test(card.token || '') || !uuid.test(card.message || '') || !safeOutputPath(card.path) ||
        typeof card.name !== 'string' || !card.name || card.name.length > 256 || /[\\/\u0000-\u001f\u007f]/.test(card.name) ||
        `claude:${card.conversation}` !== conversationId()) return null;
    const node = unique(all('[data-testid="file-card-open"][data-cds="CardLink"][role="button"]').filter(row => row.getAttribute('data-clf-claude-file-token') === card.token));
    const message = node?.closest('[data-testid="assistant-message"]');
    const id = `${conversationId()}:assistant:${card.message}`, owner = turns().filter(turn => turn.id === id);
    return message && owner.length === 1 && owner[0].node === message && turnIdOf(message) === id &&
      node.closest('[data-testid="file-card-block"][data-file-row-card]') ? node : null;
  };
  let nativeFiles = null;
  const widgetNode = widget => {
    if (!widget || !uuid.test(widget.token || '') || !uuid.test(widget.message || '') ||
        !/^toolu_[A-Za-z0-9]{20,100}$/.test(widget.toolUseId || '') || `claude:${widget.conversation}` !== conversationId() ||
        typeof widget.streaming !== 'boolean' || typeof widget.content !== 'string' || !widget.content || widget.content.length > 240000 ||
        typeof widget.title !== 'string' || widget.title.length > 200) return null;
    const nodes = all('[id^="mcp-app-container-toolu_"]').filter(node => node.id === `mcp-app-container-${widget.toolUseId}` &&
      node.getAttribute('data-clf-claude-widget-token') === widget.token);
    const node = nodes.length === 1 ? nodes[0] : null, message = node?.closest('[data-testid="assistant-message"]');
    const id = `${conversationId()}:assistant:${widget.message}`, owner = turns().filter(turn => turn.id === id);
    const frames = node ? all('iframe', node) : [];
    return message && owner.length === 1 && owner[0].node === message && turnIdOf(message) === id && frames.length === 1 &&
      frames[0].title === `visualize: ${widget.title}` ? node : null;
  };
  function readNativeFiles(current) {
    if (!current()) return Promise.resolve(null);
    const route = location.pathname, nonce = crypto.randomUUID();
    return new Promise(resolve => {
      let done = false;
      const finish = value => { if (done) return; done = true; clearTimeout(timer); window.removeEventListener('message', receive); resolve(value); };
      const receive = event => {
        if (event.source !== window || event.origin !== location.origin || event.data?.type !== 'onecode-claude-file-read-result' || event.data.nonce !== nonce) return;
        if (!current() || location.pathname !== route || event.data.path !== route || !Array.isArray(event.data.cards) || event.data.cards.length > 32) return finish(null);
        const cards = event.data.cards.filter(card => fileCardNode(card));
        const widgets = Array.isArray(event.data.widgets) && event.data.widgets.length <= 32 ? event.data.widgets.filter(widget => widgetNode(widget)) : [];
        const snapshot = { route, cards, widgets, viewer: event.data.viewer };
        nativeFiles = snapshot; finish(snapshot);
      };
      window.addEventListener('message', receive);
      const timer = setTimeout(() => finish(null), 2000);
      window.postMessage({ type: 'onecode-claude-file-read', nonce }, location.origin);
    });
  }
  const fileModeGroup = () => unique(all('[role="radiogroup"][data-cds="SegmentedControl"][aria-label="File view mode"]'));
  const fileModeRadio = name => {
    const group = fileModeGroup();
    return group ? unique(all('[role="radio"]', group).filter(node => node.getAttribute('aria-label') === name)) : null;
  };
  const fileKind = (name, language = '', mimeType = '') => /\.(?:mermaid|mmd)$/i.test(name) || language === 'mermaid' || mimeType === 'application/vnd.ant.mermaid' ? 'diagram'
    : /\.(?:md|markdown)$/i.test(name) || language === 'markdown' ? 'markdown'
      : /\.(?:jsx|tsx|html?|svg)$/i.test(name) || ['jsx', 'tsx', 'html', 'svg'].includes(language) || mimeType === 'application/vnd.ant.react' ? 'web'
        : /\.(?:json|csv|tsv)$/i.test(name) ? 'data' : /\.(?:js|ts|py|sh|css)$/i.test(name) ? 'code' : 'document';
  const nativeOutputs = () => ({ images: [], videos: [], artifacts: nativeFiles?.route === location.pathname ? [...nativeFiles.cards
    // A .js/.ts or extensionless output may be a React/web artifact. Do not
    // create an immutable pending presentation with a guessed code/document
    // kind before this exact viewer exposes its native source type.
    .filter(card => card.streaming === true && /\.(?:jsx|tsx|html?|svg|mermaid|mmd|md|markdown)$/i.test(card.name) && fileCardNode(card))
    .map(card => ({ messageId: `${conversationId()}:assistant:${card.message}`,
      nativeSurface: `artifact:${card.path}`, title: card.title || card.name, kind: fileKind(card.name), entrypoint: card.name })),
      ...(nativeFiles.widgets || []).filter(widget => widget.streaming && widgetNode(widget)).map(widget => ({
        messageId: `${conversationId()}:assistant:${widget.message}`, nativeSurface: `widget:${widget.toolUseId}`,
        title: widget.title, kind: 'web', entrypoint: 'widget.html' }))] : [] });
  const capturedFiles = new WeakMap();
  async function readNativeArtifacts(current) {
    const first = await readNativeFiles(current); if (!first || !current()) return [];
    const widgets = first.widgets.filter(widget => !widget.streaming && widgetNode(widget) &&
      widgetNode(widget).closest('[data-testid="assistant-message"]').getAttribute('data-is-streaming') === 'false').map(widget => ({
      messageId: `${conversationId()}:assistant:${widget.message}`, nativeSurface: `widget:${widget.toolUseId}`,
      title: widget.title, kind: 'web', entrypoint: 'widget.html',
      files: [{ path: 'widget.html', text: widget.content, language: 'html', mimeType: 'text/html' }] }));
    const files = await readNativeFileArtifacts(current, first);
    return current() && nativeFiles?.route === location.pathname ? [...widgets, ...files] : [];
  }
  async function readNativeFileArtifacts(current, first) {
    const cards = first.cards.filter(card => card.selected === true && fileCardNode(card)?.getAttribute('aria-current') === 'true');
    if (cards.length !== 1) return [];
    const card = cards[0], node = fileCardNode(card), route = location.href;
    if (card.streaming) { capturedFiles.delete(node); return []; }
    let interrupted = false, changedMode = false;
    const note = event => { if (event.isTrusted) interrupted = true; };
    const owns = () => !interrupted && current() && location.href === route && fileCardNode(card) === node && node?.getAttribute('aria-current') === 'true';
    const exactViewer = snapshot => {
      const viewer = snapshot?.viewer;
      return viewer && viewer.token === card.token && viewer.conversation === card.conversation && viewer.message === card.message &&
        viewer.path === card.path && viewer.name === card.name && typeof viewer.content === 'string' && viewer.content.length <= 1024 * 1024 &&
        typeof viewer.mimeType === 'string' && viewer.mimeType.length <= 128 && typeof viewer.language === 'string' && viewer.language.length <= 40 ? viewer : null;
    };
    for (const type of ['pointerdown', 'keydown']) document.addEventListener(type, note, true);
    try {
      let viewer = exactViewer(first);
      if (!viewer) {
        const captured = capturedFiles.get(node);
        // No provider revision is available for this generated file. Keep the
        // local snapshot rather than flipping Code/Preview on every transcript
        // tick. A new native message/card, renewed generation or readable Code
        // source admits a new independently hashed local snapshot.
        if (captured?.message === card.message && captured.path === card.path) return [];
        const preview = fileModeRadio('Preview'), code = fileModeRadio('Code');
        if (!owns() || !enabled(preview) || !enabled(code) || preview.getAttribute('aria-checked') !== 'true' || code.getAttribute('aria-checked') !== 'false') return [];
        changedMode = true; code.click();
        if (!await waitFor(() => fileModeRadio('Code')?.getAttribute('aria-checked') === 'true', owns, 2500)) return [];
        viewer = exactViewer(await readNativeFiles(owns));
      }
      if (!viewer || !owns() || card.streaming || node.closest('[data-testid="assistant-message"]').getAttribute('data-is-streaming') !== 'false') return [];
      const language = viewer.language.toLowerCase(), kind = fileKind(card.name, language, viewer.mimeType);
      capturedFiles.set(node, { message: card.message, path: card.path });
      return [{ messageId: `${conversationId()}:assistant:${card.message}`, nativeSurface: `artifact:${card.path}`, title: card.title || card.name,
        kind, entrypoint: card.name, ...(viewer.content.length > 240000 || !viewer.content ? { status: 'failed' }
          : { files: [{ path: card.name, text: viewer.content, language, mimeType: viewer.mimeType }] }) }];
    } finally {
      // Restore only our own unchanged selected viewer. A user's intervening
      // file/mode choice retires the operation instead of being overwritten.
      if (changedMode && owns()) {
        const preview = fileModeRadio('Preview');
        if (enabled(preview) && preview.getAttribute('aria-checked') === 'false') { preview.click(); await waitFor(() => fileModeRadio('Preview')?.getAttribute('aria-checked') === 'true', owns, 2000); }
      }
      for (const type of ['pointerdown', 'keydown']) document.removeEventListener(type, note, true);
    }
  }
  let pickerCurrent = () => false;
  const picker = CLF_CLAUDE_MODELS.create({ current: () => pickerCurrent() });
  const inspectModelSettings = async (current, failure, model = null) => { pickerCurrent = current; const choices = await picker.inspect(model); if (!choices) failure?.(picker.failureCode() || 'picker_unavailable'); return choices; };
  const prepareModelInspection = async (model, current) => { pickerCurrent = current; return picker.prepare(model); };
  const selectModelSettings = async (model, effort, current, failure, _modelSurface, modelLabel) => {
    // Automatic preserves the provider's native choice without reopening its
    // model and legacy submenus on every ordinary message.
    if (!model && !effort) return current() && Boolean(composer());
    pickerCurrent = current; return picker.select(model, effort, failure, modelLabel);
  };
  const visibleModelSelection = () => picker.currentSelection();
  async function send({ stillCurrent = () => true, clearAcceptedDraft = true, beforeSend = null, acceptUserReceipt = null,
    matchesUser = null, receiptTimeoutMs = null, acceptanceTimeoutMs = 30000, explain = null, whileGenerating = false,
    initialDraft = null, prepareAttachments = null, onSendAttempt = null } = {}) {
    const refuse = reason => { explain?.(reason); return false; };
    let box = composer();
    const start = conversationId(), submitted = initialDraft?.text ?? composerAuthoredText(), route = location.href;
    if (!submitted || !stillCurrent() || (!initialDraft && !composerWritable())) return refuse('editor-not-ready');
    if (generating() && !whileGenerating) return refuse('page-busy');
    if (whileGenerating && (!start || typeof acceptUserReceipt !== 'function')) return refuse('page-busy');
    let edited = false, clicked = false, stopped = false, rawRead = null, queueCommitAttempted = false;
    const priorQueue = new Set(queuedSendButtons());
    // A pre-existing native queue belongs to its author, not this draft lease.
    if (whileGenerating && priorQueue.size) return refuse('queued-message-present');
    const prior = new Set(turns().filter(row => row.role === 'user').map(row => row.id));
    const noteEdit = event => {
      if (!event.isTrusted) return;
      const button = event.type === 'click' ? event.target?.closest?.('button,[role="button"]') : null;
      const queued = clicked && whileGenerating ? queuedSendButtons().filter(node => !priorQueue.has(node)) : [];
      // A person's Send now commits the same queued input. Do not click it again.
      if (button && queued.length === 1 && queued[0] === button) { queueCommitAttempted = true; return; }
      if (event.target?.closest?.(`${BOX},[data-cds-composer-attachments],[data-cds-composer-attachments-row]`) ||
          button && (event.target?.closest?.('[role="menu"]') || button === attachButton() || button === sendButton())) edited = true;
    };
    const lease = () => !edited && stillCurrent() && location.href === route;
    const current = () => {
      if (!lease()) return false;
      const next = composer();
      if (next !== box) {
        if (!next || !initialDraft?.rebind?.()) return false;
        box = next;
      }
      return composerWritable() && composerAuthoredText() === submitted && (!initialDraft || initialDraft.current());
    };
    const edits = ['beforeinput', 'input', 'paste', 'drop', 'click'];
    for (const type of edits) document.addEventListener(type, noteEdit, true);
    try {
      // Claude keeps its MCP connector enabled at account/chat setup. Ordinary
      // sends neither mention it nor open/toggle its native connector picker.
      // The app's exact task capability, Send authorization and native ACK still
      // own every local tool call; native connector settings are not caller proof.
      if (prepareAttachments && !await prepareAttachments(current)) return refuse('attachment-upload-unconfirmed');
      const ready = await waitFor(() => {
        if (!current()) return null;
        if (enabled(sendButton()) && (!generating() || whileGenerating)) return sendButton();
        if (whileGenerating && !stopped && enabled(stopButton())) { stopped = true; stopButton().click(); }
        return null;
      }, initialDraft ? lease : current, acceptanceTimeoutMs);
      if (!ready || !current()) return refuse('send-not-ready');
      if (beforeSend && await beforeSend(current) !== true) return refuse('not-authorized');
      const button = sendButton();
      if (!current() || !enabled(button)) return refuse('draft-changed');
      if (whileGenerating && queuedSendButtons().length) return refuse('queued-message-present');
      if (skillSelection(box)) outgoingSkill = { expected: submitted, prior, conversation: start, current: stillCurrent };
      rawRead = { prior, submitted, current: () => !edited && stillCurrent(), until: Date.now() + (receiptTimeoutMs || 180000) };
      nativeUserReceiptRead = rawRead;
      onSendAttempt?.(); clicked = true; button.click();
      let elected = start;
      const accepted = await waitFor(() => {
        const conversation = conversationId(); if (!conversation) return null;
        if (!elected) elected = conversation;
        if (conversation !== elected) return null;
        const users = messages().filter(row => row.role === 'user'), candidate = users.at(-1);
        if (whileGenerating) {
          const queued = queuedSendButtons().filter(node => !priorQueue.has(node));
          // The first Send only queues a busy Claude message. Advance the one
          // new queue created by this exclusive, authorized Send, once. Native
          // receipt/ACK below still owns delivery and task authorization.
          if (queued.length) {
            if (!queueCommitAttempted && queued.length === 1 && enabled(queued[0]) && !composerAuthoredText() &&
                !edited && stillCurrent() && location.href === route &&
                users.every(row => prior.has(row.id) || (matchesUser ? matchesUser(row, submitted) : clean(row.text) === submitted))) {
              queueCommitAttempted = true; queued[0].click();
            }
            return null;
          }
        }
        if (!candidate || !nativeUserIdValid(candidate.id, conversation) || prior.has(candidate.id) ||
            (matchesUser ? !matchesUser(candidate, submitted) : clean(candidate.text) !== submitted) ||
            acceptUserReceipt && !acceptUserReceipt(candidate, conversation)) return null;
        return candidate;
      }, () => !edited && stillCurrent() && (!elected || conversationId() === elected), receiptTimeoutMs || 180000);
      if (!accepted) return refuse('send-acceptance-unconfirmed');
      witnessedUserBodies.set(accepted.node, { id: accepted.id, html: accepted.node.innerHTML, text: accepted.text });
      outgoingSkill = null;
      if (clearAcceptedDraft && composer() === box && composerAuthoredText() === submitted && stillCurrent()) clearPromptExact(submitted);
      return true;
    } catch { return refuse(clicked ? 'send-acceptance-unconfirmed' : 'page-unavailable'); }
    finally {
      if (nativeUserReceiptRead === rawRead) nativeUserReceiptRead = null;
      for (const type of edits) document.removeEventListener(type, noteEdit, true);
    }
  }
  const conversationTitle = () => document.title.replace(/\s*[-–|]\s*Claude\s*$/, '').trim();
  const newChatControl = async (current = () => true) => current() ? unique(all('a[href="/new"][aria-label="New chat"],a[href="/new"][data-testid="new-chat-button"]')) : null;
  const surfaceGroup = () => unique(all('[role="radiogroup"][data-cds="SegmentedControl"][aria-label="Surface"]'));
  function surfaceRows() {
    const group = surfaceGroup(); if (!group) return null;
    const rows = all(':scope > [role="radio"]', group).filter(shown).map(node => {
      const copy = node.cloneNode(true); for (const icon of copy.querySelectorAll('[data-cds="Icon"],svg,[aria-hidden="true"]')) icon.remove();
      return { node, label: compact(text(copy)), selected: node.getAttribute('aria-checked') === 'true' };
    });
    return rows.length === 2 && rows.every(row => ['Chat', 'Cowork'].includes(row.label)) &&
      new Set(rows.map(row => row.label)).size === 2 && rows.filter(row => row.selected).length === 1 ? rows : null;
  }
  async function prepareChatModelSurface(current) {
    if (!current() || !composer()) return false;
    if (conversationId()) return true; // An existing /chat UUID keeps its own identity.
    if (!isAppHomePath(location.pathname)) return false;
    const rows = surfaceRows() || await waitFor(surfaceRows, current, 3500);
    if (!rows || !current()) return false;
    const chat = rows.find(row => row.label === 'Chat'); if (!chat || !enabled(chat.node)) return false;
    if (chat.selected) return true;
    // A mode switch may replace the editing host. Only an empty fresh composer
    // may cross it; a restored human draft or attachment remains protected.
    if (composerAuthoredText() || hasComposerAttachments()) return false;
    chat.node.click();
    return Boolean(await waitFor(() => {
      const next = surfaceRows();
      return next?.some(row => row.label === 'Chat' && row.selected) && next.some(row => row.label === 'Cowork' && !row.selected) &&
        composer() && !composerAuthoredText() && !hasComposerAttachments();
    }, current, 3500));
  }
  const composerActions = () => { const button = sendButton() || stopButton(); return button?.parentElement ? { host: button.parentElement, before: button } : null; };
  return {
    provider: 'claude', TURN_SELECTOR: TURN, AUTHORED_SELECTOR: '[data-cds="Prose"]',
    conversationFromPath, isAppHomePath, conversationId, conversationTitle, nativeUserIdValid, nativeMessageIdValid, turnIdOf, messageIdOf, turns, presentationTurns: turns,
    messages, messagesIn, messageComplete, completedResponseReceipt, recoveryTerminalReceipt,
    sectionSignature: node => `${turnIdOf(node) || ''}:${text(node).length}`, composer, composerBox, composerWritable,
    composerVisible: () => shown(composer()), composerAuthoredText, composerSubmitReady: () => enabled(sendButton()), composerActions,
    composerStack: () => { const box = composerBox(); return box?.parentElement ? { host: box.parentElement, before: box } : null; },
    userPromptText, presentUserPrompts: () => {}, userMessageReaction: () => undefined,
    firstUserMessage: () => turns().find(row => row.role === 'user')?.node || null,
    insertPrompt, clearPromptExact, captureComposerDraft, prepareNativeSkill, send, sendButton, stopButton, stopGeneration, generating,
    setConnectorNames, connectorNames, setConnectorApps, connectorApps,
    approvalCard, answerApprovalCard: () => false, approvalWaiting, maybeAutoApprove: async () => false,
    hasComposerAttachments, composerAttachmentNames, uploadImages, visibleModelSelection, inspectModelSettings, prepareModelInspection, selectModelSettings,
    newChatControl, prepareChatModelSurface, modelPickerReadable: async () => Boolean(CLF_CLAUDE_MODELS.button()),
    conversationLoadFailure: () => null, errors, temporaryChatReady: () => false, localHelperReady: () => localHelper && Boolean(composer()),
    helperHistory: 'normal-provider-history', confirmTemporaryChatIntroduction: () => {},
    signedIn: () => unique(all('button[data-testid="user-menu-button"][aria-haspopup="menu"]')) && composer() ? true : null,
    projectHomeId: () => null, projectCreateControl: () => null, projectCreateForm: () => null, projectIdsShown: () => [],
    revealSidebar: () => false, fillProjectName: () => false, enterProject: async () => false,
    pluginRefreshView: async () => null, pluginInstalledButtons: () => null, pluginManagementIdle: () => false,
    nativeOutputs, readNativeArtifacts, richMessageNodes,
    pageTheme: () => document.documentElement.classList.contains('dark') || getComputedStyle(document.documentElement).colorScheme === 'dark' ? 'dark' : 'light',
    clearRevivalResidue: () => false, progressLine: () => null, progressItems: () => [], interrupted: () => false, markProgress: () => {},
    toolBlocks: () => [], activityItems: () => [], isConnectorBlock: () => false, markLocalBlock: () => {}, hasConnectorRow: () => false,
    connectorRows: () => [], fiberRef: () => null, activitySummaryRows: () => [], thoughtActivityRows: () => [], toolLabel: text,
    hideProgress: () => {}, hideActivity: () => {}, activityFold: () => null, collapsedActivityFold: () => null,
    canHideActivity: () => false, replaceActivity: () => {}
  };
})();
