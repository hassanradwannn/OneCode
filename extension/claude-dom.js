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
  const acceptedSkillQuestions = new Map();
  let outgoingSkill = null;
  const skillChipSelector = 'span.react-renderer.node-skillChip[data-skill-id="onecode"][contenteditable="false"]';
  const sentSkillGroup = ':scope > p.whitespace-pre-wrap > span[class~="group/chip"]';
  function skillSelection(box = composer()) {
    const proof = box && nativeSkillSelections.get(box);
    return proof && proof.route === location.href && proof.token.isConnected && proof.token.closest(BOX) === box &&
      proof.token.matches(skillChipSelector) && compact(proof.token.textContent) === '/onecode' ? proof : null;
  }
  const composerAuthoredText = () => {
    const box = composer(), proof = skillSelection(box); if (!proof) return blockText(box);
    const copy = box.cloneNode(true), candidates = all(skillChipSelector, box), index = candidates.indexOf(proof.token);
    if (index < 0) return blockText(box); all(skillChipSelector, copy)[index]?.remove(); return blockText(copy);
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
  const proseNodes = root => all('[data-cds="Prose"]', root).filter(node => !node.parentElement?.closest('[data-cds="Prose"]') &&
    !node.closest('[data-cds="TurnStatus"],[data-find-omitted],button') && shown(node));
  function messagesIn(turn, _index = 0, seen = new Set()) {
    if (!turn?.node?.isConnected || !turn.id || turn.id !== turnIdOf(turn.node) || seen.has(turn.id)) return [];
    let value;
    if (turn.role === 'user') {
      const authored = all(':scope > div.contents', turn.node);
      if (authored.length !== 1) return [];
      value = userAuthoredText(authored[0], turn.id);
    }
    else {
      const parts = proseNodes(turn.node).map(node => {
        const copy = node.cloneNode(true);
        for (const drop of copy.querySelectorAll(`${OWN},button,script,style,[data-cds="TurnStatus"],[data-find-omitted],[role="toolbar"]`)) drop.remove();
        return typeof CLF_GEMINI_MARKDOWN !== 'undefined' ? CLF_GEMINI_MARKDOWN.render(copy) : blockText(copy);
      });
      value = parts.filter(Boolean).join('\n\n');
    }
    if (!value) return [];
    seen.add(turn.id);
    // Full user readback stays private evidence for the durable exact task receipt.
    // Only userPromptText removes its app frame in presentation.
    return [{ id: turn.id, role: turn.role, text: value, turnId: turn.id, node: turn.node, interrupted: false }];
  }
  const messages = () => { const seen = new Set(); return turns().flatMap((turn, at) => messagesIn(turn, at, seen)); };
  function userAuthoredText(root, id) {
    const raw = blockText(root);
    const chips = all(sentSkillGroup, root).filter(wrapper => {
      const buttons = all(':scope > span[role="button"][type="button"][tabindex="0"][data-base-ui-click-trigger][aria-haspopup="dialog"]', wrapper);
      if (buttons.length !== 1 || compact(buttons[0].textContent) !== '/onecode') return false;
      const slash = all('span[aria-hidden="true"]', buttons[0]).filter(node => compact(node.textContent) === '/');
      if (slash.length !== 1) return false;
      const range = document.createRange(); range.selectNodeContents(root); range.setEndBefore(wrapper);
      return !compact(range.toString());
    });
    if (chips.length !== 1) return raw;
    const copy = root.cloneNode(true), allGroups = all(sentSkillGroup, root);
    all(sentSkillGroup, copy)[allGroups.indexOf(chips[0])]?.remove();
    const candidate = blockText(copy), accepted = acceptedSkillQuestions.get(id);
    const outgoing = outgoingSkill && outgoingSkill.current() && !outgoingSkill.prior.has(id) &&
      (!outgoingSkill.conversation || id.startsWith(`${outgoingSkill.conversation}:user:`)) ? outgoingSkill : null;
    if (accepted && candidate === accepted || outgoing && candidate === outgoing.expected) {
      if (outgoing) { acceptedSkillQuestions.set(id, candidate); if (acceptedSkillQuestions.size > 512) acceptedSkillQuestions.delete(acceptedSkillQuestions.keys().next().value); }
      return candidate;
    }
    // Reloaded historical presentation can recognize the same native chip and
    // an intact app frame. This never marks a skill selected or authorizes Send.
    return userPromptText(candidate) !== null ? candidate : raw;
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
      document.execCommand?.('insertText', false, next);
      // Do not manufacture a native editor document by setting textContent.
      // ProseMirror must accept the editor-native edit and expose its full readback.
      const applied = composer() === box && composerAuthoredText() === clean(next);
      if (applied && !preserveSkill) nativeSkillSelections.delete(box);
      return applied;
    }, false);
  }
  const insertPrompt = (value, mode = false, failure = null) => editPrompt(value, mode, failure);
  const clearPromptExact = expected => composerAuthoredText() === clean(expected) && editPrompt('', true, null, false);
  function captureComposerDraft(expected, current = () => true) {
    let box = composer(), retired = false, attached = null;
    const owns = () => !retired && current() && composer() === box && box?.isConnected && composerAuthoredText() === clean(expected) &&
      (!attached || attachmentRows().length === attached.length && attached.every(row => row.node.isConnected && attachmentRows().includes(row.node) && attachmentName(row.node) === row.name));
    return { current: owns, clear: async () => owns() && clearPromptExact(expected), withdraw: () => { if (!owns()) return false; retired = true; return true; },
      dispose: () => { retired = true; }, attachments: nodes => { attached = nodes.map(node => ({ node, name: attachmentName(node) })); },
      rebind: () => { if (retired || !current() || composerAuthoredText() !== clean(expected)) return false; box = composer(); return Boolean(box); } };
  }
  async function prepareNativeSkill(name, current = () => true) {
    if (name !== 'onecode' || !current()) return { selected: false };
    const box = composer(), route = location.href, conversation = conversationId();
    if (!box || !composerWritable() || composerAuthoredText() || hasComposerAttachments() || all(skillChipSelector, box).length) return { selected: false };
    const questions = messages().filter(row => row.role === 'user').map(row => row.id).join('\u0000');
    let interrupted = false, performing = false, success = false;
    const act = run => { performing = true; try { return run(); } finally { performing = false; } };
    const note = event => { if (event.isTrusted && !performing) interrupted = true; };
    const owns = () => !interrupted && current() && location.href === route && conversationId() === conversation && composer() === box && box.isConnected &&
      !hasComposerAttachments() && messages().filter(row => row.role === 'user').map(row => row.id).join('\u0000') === questions;
    const slashMenu = () => unique(all('[data-cds-portal] [role="menu"][data-positioning="native-anchor"]').filter(menu =>
      menu.style.getPropertyValue('position-anchor') === '--slash-command-menu' || menu.style.positionAnchor === '--slash-command-menu'));
    for (const type of ['pointerdown', 'keydown', 'beforeinput', 'input']) document.addEventListener(type, note, true);
    try {
      if (all('[role="menu"]').some(shown) || !act(() => insertPrompt('/', true))) return { selected: false };
      const searching = () => owns() && composerAuthoredText() === '/';
      const menu = await waitFor(slashMenu, searching, 2500); if (!menu) return { selected: false };
      const row = await waitFor(() => unique(all('[role="menuitem"]', menu).filter(item => item.closest('[role="menu"]') === menu &&
        enabled(item) && leadingName(item) === name)), searching, 2000);
      if (!row || !searching()) return { selected: false };
      act(() => row.click());
      const token = await waitFor(() => {
        const candidates = all(skillChipSelector, box).filter(node => shown(node) && compact(node.textContent) === '/onecode' &&
          all('[data-node-view-wrapper][contenteditable="false"]', node).length === 1);
        return candidates.length === 1 ? candidates[0] : null;
      }, owns, 2500);
      if (!token || !owns()) return { selected: false };
      const proof = { name, token, route };
      nativeSkillSelections.set(box, proof);
      if (composerAuthoredText()) { nativeSkillSelections.delete(box); return { selected: false }; }
      success = true;
      return { selected: true, current: () => current() && composer() === box && skillSelection(box) === proof };
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
  const attachmentRows = () => all('[data-cds-composer-attachments] [data-testid="file-thumbnail"][data-cds-attachment]').filter(shown);
  const attachmentRemove = row => {
    const controls = all('button[data-cds-attachment-remove][aria-label^="Remove "]', row);
    return controls.length === 1 ? controls[0] : null;
  };
  const attachmentName = row => {
    const label = attachmentRemove(row)?.getAttribute('aria-label');
    return label && label.startsWith('Remove ') && label.length > 7 && label.length <= 519 ? label.slice(7) : null;
  };
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
  function readComposerFiles(current) {
    if (!current()) return Promise.resolve(null);
    const route = location.pathname, nonce = crypto.randomUUID(), box = composer();
    return new Promise(resolve => {
      let done = false;
      const finish = value => { if (done) return; done = true; clearTimeout(timer); window.removeEventListener('message', receive); resolve(value); };
      const receive = event => {
        if (event.source !== window || event.origin !== location.origin || event.data?.type !== 'onecode-claude-composer-read-result' || event.data.nonce !== nonce) return;
        const proof = event.data.composer;
        if (!current() || composer() !== box || location.pathname !== route || event.data.path !== route || !proof ||
            !uuid.test(proof.token || '') || box?.getAttribute('data-clf-claude-composer-token') !== proof.token ||
            !Array.isArray(proof.files) || proof.files.length > 20 || typeof proof.uploadingFile !== 'boolean' ||
            typeof proof.uploadingSync !== 'boolean' || !Number.isSafeInteger(proof.placeholderCount)) return finish(null);
        finish(proof);
      };
      window.addEventListener('message', receive);
      const timer = setTimeout(() => finish(undefined), 2000);
      window.postMessage({ type: 'onecode-claude-composer-read', nonce }, location.origin);
    });
  }
  async function uploadImages(images = [], current = () => true, draft = null, extraFiles = []) {
    const files = [...extraFiles];
    try {
      for (const image of images || []) {
        const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-zA-Z0-9+/=]+)$/.exec(image.dataUrl || '');
        if (!match) return false;
        files.push(new File([Uint8Array.from(atob(match[2]), value => value.charCodeAt(0))], image.name || 'image.png', { type: match[1] }));
      }
    } catch { return false; }
    if (!files.length) return true;
    const box = composer(), route = location.href;
    if (files.length > 20 || files.some(file => !file.name || file.name.length > 512) || !box || !composerWritable() ||
        !current() || !draft?.current() || hasComposerAttachments()) return false;
    const inputs = all('input#chat-input-file-upload-bottom[type="file"][data-testid="file-upload"][aria-label="Upload files"][multiple]')
      .filter(node => node.isConnected && !node.disabled && !node.closest(OWN));
    if (inputs.length !== 1) return false;
    const input = inputs[0];
    let dock = input.parentElement;
    while (dock && (!dock.hasAttribute('data-cds-dock-group') || !dock.contains(box))) dock = dock.parentElement;
    if (!dock || !dock.contains(input) || !dock.contains(box)) return false;
    let interrupted = false;
    const note = event => { if (event.isTrusted && (dock.contains(event.target) || event.target?.matches?.('input[type="file"]'))) interrupted = true; };
    const owns = () => !interrupted && current() && draft.current() && location.href === route && composer() === box && box.isConnected;
    const priorAlerts = new Set(errors().map(error => error.node));
    for (const type of ['beforeinput', 'input', 'change', 'pointerdown']) document.addEventListener(type, note, true);
    try {
      if (!owns()) return false;
      const transfer = new DataTransfer(); for (const file of files) transfer.items.add(file);
      // One native input change only. A lost/ambiguous upload is left in the
      // unsent composer and is never retried or replaced automatically.
      input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true }));
      const deadline = Date.now() + (extraFiles.length ? 600000 : 60000);
      while (owns() && Date.now() < deadline) {
        if (errors().some(error => !priorAlerts.has(error.node))) return false;
        const rows = attachmentRows(); if (rows.length > files.length) return false;
        const proof = await readComposerFiles(owns);
        if (!owns()) return false;
        if (proof === undefined) return false;
        const currentRows = attachmentRows();
        if (proof && proof.uploadingFile === false && proof.uploadingSync === false && proof.placeholderCount === 0 &&
            proof.files.length === files.length && currentRows.length === files.length && enabled(sendButton())) {
          const unmatched = proof.files.slice();
          const matches = files.every(file => {
            const at = unmatched.findIndex(item => item?.name === file.name && item.ready === true &&
              (item.kind === 'file' && typeof item.type === 'string' || item.kind === 'image' && /^image\//i.test(file.type)) && Number.isSafeInteger(item.size) && item.size >= 0 &&
              uuid.test(item.token || '') && currentRows.some(row => row.getAttribute('data-clf-claude-attachment-token') === item.token && attachmentName(row) === file.name &&
                attachmentRemove(row)?.disabled !== true && attachmentRemove(row)?.getAttribute('aria-disabled') !== 'true' &&
                !row.hasAttribute('data-state') && row.getAttribute('aria-busy') !== 'true'));
            if (at < 0) return false; unmatched.splice(at, 1); return true;
          });
          if (matches) { draft.attachments(currentRows); return draft.current(); }
        }
        await new Promise(resolve => setTimeout(resolve, 150));
      }
      return false;
    } catch { return false; }
    finally { for (const type of ['beforeinput', 'input', 'change', 'pointerdown']) document.removeEventListener(type, note, true); }
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
        const snapshot = { route, cards, viewer: event.data.viewer };
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
  const nativeOutputs = () => ({ images: [], videos: [], artifacts: nativeFiles?.route === location.pathname ? nativeFiles.cards
    // A .js/.ts or extensionless output may be a React/web artifact. Do not
    // create an immutable pending presentation with a guessed code/document
    // kind before this exact viewer exposes its native source type.
    .filter(card => card.streaming === true && /\.(?:jsx|tsx|html?|svg|mermaid|mmd|md|markdown)$/i.test(card.name) && fileCardNode(card))
    .map(card => ({ messageId: `${conversationId()}:assistant:${card.message}`,
      nativeSurface: `artifact:${card.path}`, title: card.title || card.name, kind: fileKind(card.name), entrypoint: card.name })) : [] });
  const capturedFiles = new WeakMap();
  async function readNativeArtifacts(current) {
    const first = await readNativeFiles(current); if (!first || !current()) return [];
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
  const selectModelSettings = async (model, effort, current, failure) => {
    // Automatic preserves the provider's native choice without reopening its
    // model and legacy submenus on every ordinary message.
    if (!model && !effort) return current() && Boolean(composer());
    pickerCurrent = current; return picker.select(model, effort, failure);
  };
  const visibleModelSelection = () => picker.currentSelection();
  async function send({ stillCurrent = () => true, clearAcceptedDraft = true, beforeSend = null, acceptUserReceipt = null,
    matchesUser = null, receiptTimeoutMs = null, acceptanceTimeoutMs = 30000, explain = null, whileGenerating = false,
    initialDraft = null, prepareAttachments = null, onSendAttempt = null } = {}) {
    const refuse = reason => { explain?.(reason); return false; };
    const box = composer(), start = conversationId(), submitted = composerAuthoredText(), route = location.href;
    if (!box || !submitted || !composerWritable() || !stillCurrent() || initialDraft && !initialDraft.current()) return refuse('editor-not-ready');
    if (generating() && !whileGenerating) return refuse('page-busy');
    if (whileGenerating && (!start || typeof acceptUserReceipt !== 'function')) return refuse('page-busy');
    let edited = false, clicked = false, stopped = false;
    const prior = new Set(messages().filter(row => row.role === 'user').map(row => row.id));
    const noteEdit = event => { if (event.isTrusted && (event.target?.closest?.(BOX) ||
      event.type === 'click' && (event.target?.closest?.('[role="menu"]') || event.target?.closest?.('button') === attachButton()))) edited = true; };
    const current = () => !edited && stillCurrent() && location.href === route && composer() === box &&
      composerAuthoredText() === submitted && (!initialDraft || initialDraft.current());
    for (const type of ['beforeinput', 'input', 'click']) document.addEventListener(type, noteEdit, true);
    try {
      // Claude keeps its MCP connector enabled at account/chat setup. Ordinary
      // sends neither mention it nor open/toggle its native connector picker.
      // The app's exact task capability, Send authorization and native ACK still
      // own every local tool call; native connector settings are not caller proof.
      if (prepareAttachments && !await prepareAttachments(current)) return refuse('attachment-upload-unconfirmed');
      const ready = await waitFor(() => {
        if (enabled(sendButton()) && (!generating() || whileGenerating)) return sendButton();
        if (whileGenerating && !stopped && enabled(stopButton()) && current()) { stopped = true; stopButton().click(); }
        return null;
      }, current, acceptanceTimeoutMs);
      if (!ready || !current()) return refuse('send-not-ready');
      if (beforeSend && await beforeSend(current) !== true) return refuse('not-authorized');
      const button = sendButton();
      if (!current() || !enabled(button) || button !== ready) return refuse('draft-changed');
      if (skillSelection(box)) outgoingSkill = { expected: submitted, prior, conversation: start, current: stillCurrent };
      onSendAttempt?.(); clicked = true; button.click();
      let elected = start;
      const accepted = await waitFor(() => {
        const conversation = conversationId(); if (!conversation) return null;
        if (!elected) elected = conversation;
        if (conversation !== elected) return null;
        const users = messages().filter(row => row.role === 'user'), candidate = users.at(-1);
        if (!candidate || !nativeUserIdValid(candidate.id, conversation) || prior.has(candidate.id) ||
            (matchesUser ? !matchesUser(candidate, submitted) : clean(candidate.text) !== submitted) ||
            acceptUserReceipt && !acceptUserReceipt(candidate, conversation)) return null;
        return candidate;
      }, () => !edited && stillCurrent() && (!elected || conversationId() === elected), receiptTimeoutMs || 180000);
      if (!accepted) return refuse('send-acceptance-unconfirmed');
      outgoingSkill = null;
      if (clearAcceptedDraft && composer() === box && composerAuthoredText() === submitted && stillCurrent()) clearPromptExact(submitted);
      return true;
    } catch { return refuse(clicked ? 'send-acceptance-unconfirmed' : 'page-unavailable'); }
    finally { for (const type of ['beforeinput', 'input', 'click']) document.removeEventListener(type, noteEdit, true); }
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
    nativeOutputs, readNativeArtifacts,
    pageTheme: () => document.documentElement.classList.contains('dark') || getComputedStyle(document.documentElement).colorScheme === 'dark' ? 'dark' : 'light',
    clearRevivalResidue: () => false, progressLine: () => null, progressItems: () => [], interrupted: () => false, markProgress: () => {},
    toolBlocks: () => [], activityItems: () => [], isConnectorBlock: () => false, markLocalBlock: () => {}, hasConnectorRow: () => false,
    connectorRows: () => [], fiberRef: () => null, activitySummaryRows: () => [], thoughtActivityRows: () => [], toolLabel: text,
    hideProgress: () => {}, hideActivity: () => {}, activityFold: () => null, collapsedActivityFold: () => null,
    canHideActivity: () => false, replaceActivity: () => {}
  };
})();
