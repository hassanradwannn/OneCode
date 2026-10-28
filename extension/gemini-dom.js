/**
 * Native Gemini page adapter for the existing durable recorder/outbox.
 * Reads rendered page state only. No Google private API, cookies, or guessed request headers.
 * A failed/ambiguous selector leaves the operation pending rather than clicking twice.
 */
var CLF_DOM = (() => {
  const OWN = '[data-clf-root],.clf-stream,.clf-stage,.clf-composer,.clf-boot,[data-clf-user-text],#clf-control,#clf-panel';
  const TURN = 'user-query,model-response';
  const BOX = 'rich-textarea [contenteditable="true"][role="textbox"]';
  const MENTION = '[data-mention-id],[data-mention-name],.mention-chip,[contenteditable="false"][data-type="mention"]';
  const CONTROL = /\n*\[\[GEMINI_LOCAL_SESSION\]\][\s\S]*?\[\[\/GEMINI_LOCAL_SESSION\]\]\s*$/;
  const WARMUP = '[[GEMINI_LOCAL_WARMUP]] Initialize this local workspace conversation. Reply READY only. Do not call tools.';
  const SKILL_WARMUP = '@onecode-gemini ' + WARMUP;
  // A normal Gemini chat used for an app-owned, tool-free planner. This does not
  // claim Gemini native temporary mode; its native history remains in the account.
  const localHelper = new URL(location.href).searchParams.get('cos-helper') === 'planner';
  const clean = value => String(value || '').replace(/\u00a0/g, ' ').trim();
  const text = node => clean(node?.innerText ?? node?.textContent ?? '');
  const blockText = node => {
    const read = value => {
      if (value.nodeType === Node.TEXT_NODE) return value.textContent || '';
      if (value.nodeName === 'BR') return '\n';
      const children = [...value.childNodes].map(read).join('');
      // Quill represents one empty line as <p><br></p>. Its BR already supplies
      // that line: adding the paragraph terminator again corrupts framed lengths.
      const block = /^(?:P|DIV|LI|PRE|H[1-6]|BLOCKQUOTE)$/.test(value.nodeName);
      return children + (block && children !== '\n' ? '\n' : '');
    };
    return clean(node ? read(node) : '');
  };
  const compact = value => clean(value).replace(/\s+/g, ' ');
  const unescapeReadback = value => String(value || '').replace(/\\\r?\n/g, '\n')
    .replace(/\\([!-/:-@[-`{-~])/g, '$1').replace(/(^|\n)&#x20;/g, '$1 ');
  const escapedMarker = value => value.replace(/[!-/:-@[-`{-~]/g, '\\$&');
  const escapedControlOpen = escapedMarker('[[GEMINI_LOCAL_SESSION]]');
  const escapedControlClose = escapedMarker('[[/GEMINI_LOCAL_SESSION]]');
  const stripControl = value => {
    const original = String(value || '');
    if (CONTROL.test(original)) return clean(original.replace(CONTROL, ''));
    // Native user readback can escape the app frame too. Remove only its exact
    // trailing frame; do not unescape authored file paths or arbitrary user text.
    const start = original.lastIndexOf(escapedControlOpen);
    return start >= 0 && original.trimEnd().endsWith(escapedControlClose)
      ? clean(original.slice(0, start).replace(/\\\r?\n$/, '')) : clean(original);
  };
  const matchesOwnedReadback = (actual, expected) => compact(actual) === compact(expected) ||
    compact(unescapeReadback(actual)) === compact(expected);
  const promptContinuation = value => /^\[\[CLF-(?:HANDOFF|RESUME):[A-Za-z0-9_-]{16,64}\]\]\n\n/.exec(value)?.[0] || '';
  function readPromptFrame(value) {
    const identity = promptContinuation(value);
    const header = /^\[\[COS_CONTEXT:(\d{1,6})\]\]\n/.exec(value.slice(identity.length));
    if (!header) return null;
    const end = identity.length + header[0].length + Number(header[1]);
    const boundary = '\n[[/COS_CONTEXT]]\n\n';
    return value.startsWith(boundary, end) ? identity + value.slice(end + boundary.length) : null;
  }
  function userPromptText(value) {
    value = stripControl(value).replace(/\r\n?/g, '\n');
    const exact = readPromptFrame(value);
    if (exact !== null) return exact;
    const typed = value.replace(/\\\n/g, '\n').replace(/\\([!-/:-@[-`{-~])/g, '$1').replace(/(^|\n)&#x20;/g, '$1 ');
    return typed === value ? null : readPromptFrame(typed);
  }
  const safe = (fn, fallback) => { try { return fn() ?? fallback; } catch { return fallback; } };
  const shown = node => Boolean(node?.isConnected && !node.closest(`${OWN},[hidden],[aria-hidden="true"],[inert]`) &&
    node.getClientRects().length && getComputedStyle(node).display !== 'none' && getComputedStyle(node).visibility !== 'hidden');
  const enabled = node => shown(node) && !node.disabled && node.getAttribute('aria-disabled') !== 'true';
  const unique = nodes => { const list = [...nodes].filter(shown); return list.length === 1 ? list[0] : null; };
  const all = (selector, root = document) => [...root.querySelectorAll(selector)];
  const isAppHomePath = path => /^(?:\/u\/\d+)?\/app\/?$/.test(path);
  const conversationFromPath = path => /^(?:\/u\/\d+)?\/app\/([0-9a-f]{16})\/?$/i.exec(path)?.[1]?.toLowerCase() || null;
  const conversationId = () => conversationFromPath(location.pathname);
  const composer = () => unique(all(BOX));
  const composerBox = () => composer()?.closest('input-area-v2,input-container,chat-input,form') || composer()?.parentElement || null;
  const composerWritable = () => enabled(composer()) && composer()?.getAttribute('contenteditable') === 'true';
  const nativeMentions = new WeakMap();
  const acceptedMentions = new Map();
  let outgoingMention = null;
  let openingClaim = null;
  let inputClaim = null;
  let commandClaim = null;
  let goalClaim = null;
  let preparedOpening = null;
  let warmupRecoveryResolver = null, warmupInitializationResolver = null, warmupRecovery = null, warmupRefreshPending = false;
  const recoveryProjection = value => value?.spent === true && Number.isFinite(value.expiresAt) && Number.isFinite(value.at)
    ? { spent: true, questionId: typeof value.questionId === 'string' ? value.questionId : null,
      at: value.at, expiresAt: value.expiresAt,
      ...(value.initialization && Number.isFinite(value.initialization.at) ? { initialization: { at: value.initialization.at } } : {}) } : null;
  const setWarmupRecoveryResolver = handler => { warmupRecoveryResolver = typeof handler === 'function' ? handler : null; };
  const setWarmupInitializationResolver = handler => { warmupInitializationResolver = typeof handler === 'function' ? handler : null; };
  const warmupRecoveryPending = () => warmupRefreshPending;
  const warmupRouteCurrent = original => {
    if (!original) return false;
    const start = new URL(original), now = new URL(location.href);
    return start.origin === now.origin && (now.href === start.href || Boolean(conversationId() &&
      (now.pathname === start.pathname || now.pathname.replace(/\/[0-9a-f]{16}\/?$/i, '') === start.pathname.replace(/\/$/, ''))));
  };
  const warmupOutput = () => all('model-response').filter(shown).map(node =>
    text(messageNode({ node, role: 'assistant' }))).join(' ').trim();
  function openingWarmup(value) {
    // Only the validated app opening frame opts into the saved native Skill.
    // Authored mentions and unowned text cannot change this tool-free bootstrap.
    if ((!openingClaim && !commandClaim) || readPromptFrame(value) === null) return WARMUP;
    const framed = value.slice(promptContinuation(value).length);
    const header = /^\[\[COS_CONTEXT:(\d{1,6})\]\]\n/.exec(framed);
    const context = framed.slice(header[0].length, header[0].length + Number(header[1]));
    return context.split('\n', 1)[0] === '@onecode-gemini' ? SKILL_WARMUP : WARMUP;
  }
  function setOpeningClaim(value) {
    openingClaim = value && typeof value.id === 'string' && typeof value.owner === 'string'
      ? { id: value.id, owner: value.owner, ...(recoveryProjection(value.warmupRecovery) && { warmupRecovery: recoveryProjection(value.warmupRecovery) }) } : null;
    if (openingClaim) { commandClaim = null; goalClaim = null; }
    preparedOpening = null;
  }
  function setCommandClaim(value) {
    commandClaim = value && typeof value.id === 'string' && typeof value.client === 'string'
      ? { id: value.id, client: value.client, ...(recoveryProjection(value.warmupRecovery) && { warmupRecovery: recoveryProjection(value.warmupRecovery) }) } : null;
    if (commandClaim) { openingClaim = null; inputClaim = null; goalClaim = null; }
    preparedOpening = null;
  }
  function setInputClaim(value) {
    inputClaim = value && typeof value.id === 'string' && typeof value.owner === 'string' ? { id: value.id, owner: value.owner } : null;
    if (inputClaim) {
      commandClaim = null; goalClaim = null;
      // A later authored input must not carry the completed opening's claim.
      // Fresh preparation sets the matching opening explicitly after this call.
      if (openingClaim && (openingClaim.id !== inputClaim.id || openingClaim.owner !== inputClaim.owner)) {
        openingClaim = null; preparedOpening = null;
      }
    }
  }
  function setGoalClaim(value) {
    goalClaim = value && typeof value.token === 'string' && /^goal-[a-z0-9-]{1,80}$/.test(value.token) ? { token: value.token } : null;
    if (goalClaim) { openingClaim = null; inputClaim = null; commandClaim = null; preparedOpening = null; }
  }
  const preparedConversation = () => preparedOpening && (openingClaim || commandClaim) && preparedOpening === conversationId() ? preparedOpening : null;
  // A native app selection briefly replaces our task with '@'. Only this exact
  // synchronous edit snapshot can keep an existing draft lease alive while that
  // native menu is pending. A user edit, replacement editor or route change revokes it.
  const composerTransitions = new WeakMap();
  const transitionOwns = (box, expected) => {
    const edit = box && composerTransitions.get(box);
    return Boolean(edit && !edit.revoked && edit.route === location.href &&
      (edit.html === box.innerHTML || (edit.normalizationText !== null && edit.normalizationText === blockText(box))) &&
      compact(edit.expected) === compact(stripControl(expected)));
  };
  function leadingStrong(node, name) {
    const matches = all('strong', node).filter(strong => compact(text(strong)) === `@${name}`);
    if (!matches.length) return null;
    const strong = matches[0], range = document.createRange();
    range.selectNodeContents(node); range.setEndBefore(strong);
    return compact(range.toString()) ? null : strong;
  }
  function provenMention(node) {
    const own = nativeMentions.get(node);
    if (own && own.route === location.href && own.node.isConnected && leadingStrong(node, own.name) === own.node) return own;
    return null;
  }
  const authored = node => {
    if (!node) return '';
    const copy = node.cloneNode(true);
    const own = provenMention(node);
    const user = node.closest?.('user-query');
    // Gemini prepends a hidden, sometimes truncated accessibility duplicate
    // inside .query-text. The visible native paragraphs are the authored row.
    if (user) for (const label of copy.querySelectorAll('h5.screen-reader-user-query-label')) label.remove();
    const userId = user ? nativeId(user, 'user') : null;
    const sent = userId && (acceptedMentions.get(userId) || (outgoingMention?.conversationId === conversationId() &&
      (!outgoingMention.acceptedId || outgoingMention.acceptedId === userId) && !outgoingMention.priorIds.has(userId) ? outgoingMention : null));
    const strong = own?.node || (sent ? leadingStrong(node, sent.name) : null);
    if (strong) {
      const index = all('strong', node).indexOf(strong), target = all('strong', copy)[index];
      if (target) {
        const candidate = copy.cloneNode(true);
        all('strong', candidate)[index]?.remove();
        if (own || matchesOwnedReadback(stripControl(blockText(candidate)), sent.expected)) {
          target.remove();
          if (userId && sent) { if (sent === outgoingMention) sent.acceptedId = userId;
            acceptedMentions.set(userId, { name: sent.name, expected: sent.expected });
            if (acceptedMentions.size > 2000) acceptedMentions.delete(acceptedMentions.keys().next().value); }
        }
      }
    }
    for (const chip of copy.querySelectorAll(MENTION)) chip.remove();
    const result = stripControl(blockText(copy));
    if (sent && result.startsWith(`@${sent.name}`) && matchesOwnedReadback(result.slice(sent.name.length + 1), sent.expected)) {
      if (sent === outgoingMention) sent.acceptedId = userId;
      acceptedMentions.set(userId, { name: sent.name, expected: sent.expected });
      return stripControl(result.slice(sent.name.length + 1));
    }
    return result;
  };
  const composerAuthoredText = () => authored(composer());
  const sendButton = () => unique(all('button[aria-label="Send message"],button[aria-label="Send"]'));
  const stopButton = () => unique(all('button[aria-label="Stop response"],button[aria-label="Stop generating"],button[aria-label="Stop"]'));
  const nativeIds = new WeakMap();
  let nodeSerial = 0;
  function nativeId(node, role) {
    // Prefer the IDs rendered by Gemini. A per-document fallback is explicitly scoped,
    // never used to authenticate an MCP call or to infer request ownership.
    const response = node.closest('response-container,[data-response-id]');
    const exchange = node.closest('.conversation-container');
    const exchangeId = /^[0-9a-f]{16}$/i.test(exchange?.id || '') ? exchange.id.toLowerCase() : null;
    // Native shells render user-query-content-undefined/index slots before the
    // exchange ID hydrates. Those slots are not accepted-message identities:
    // publishing one then its real exchange makes one Send become two questions.
    if (exchange && !exchangeId) return null;
    const native = exchangeId || node.getAttribute('data-message-id') || node.getAttribute('data-response-id') || node.id ||
      node.querySelector('[id^="user-query-content-"],message-content[id^="message-content-id-"],[data-message-id]')?.id ||
      response?.getAttribute('data-response-id') || response?.id;
    if (/^(?:user-query-content|message-content-id)-(?:undefined|null|NaN|\d+)$/i.test(native || '')) return null;
    if (native) return `gemini:${conversationId() || 'fresh'}:${role}:${native}`;
    if (!nativeIds.has(node)) nativeIds.set(node, `gemini:${conversationId() || 'fresh'}:${role}:document-${++nodeSerial}`);
    return nativeIds.get(node);
  }
  // Native permission answers have ordinary editable user-query markup. Only
  // an exact decision click and its adjacent completed-card exchange prove
  // that a subsequent "Allow"/"Deny" was a control rather than authored text.
  const approvalReplyIds = new Set(), provisionalApprovalReplyIds = new Set(), pendingApprovalReplies = [], approvalAudit = [];
  // These are receipts of this extension's observed native clicks, never a text
  // heuristic. The worker retains them across page/browser restarts so an old
  // control reply cannot become a new authored question after a refresh.
  let approvalReceiptStore = null, approvalReceiptRoute = null, approvalReceiptLoading = null, approvalReceiptsRestored = null;
  let approvalReceiptWriting = null;
  const durableApprovalReplies = new Map(), unsavedApprovalReplies = new Map();
  const approvalScope = () => {
    const route = /^(\/u\/\d+)?\/app\/([0-9a-f]{16})\/?$/i.exec(location.pathname);
    return route ? `${route[1] || ''}/app/${route[2].toLowerCase()}` : null;
  };
  const validApprovalReceipt = row => row && /^[0-9a-f]{16}$/.test(row.sourceId) &&
    /^[0-9a-f]{16}$/.test(row.replyId) && row.replyId !== row.sourceId && /^(Allow|Deny)$/.test(row.decision);
  function approvalReceiptsReady() {
    if (!approvalReceiptStore) return true;
    const route = approvalScope();
    if (!route) return true;
    if (approvalReceiptRoute === route) return true;
    if (!approvalReceiptLoading) {
      approvalReceiptLoading = Promise.resolve().then(() => approvalReceiptStore({ conversationId: conversationId() }))
        .then(rows => {
          if (approvalScope() !== route || !Array.isArray(rows)) return;
          durableApprovalReplies.clear();
          for (const row of rows.slice(-2000)) if (validApprovalReceipt(row)) durableApprovalReplies.set(row.replyId, row);
          approvalReceiptRoute = route;
        }).catch(() => undefined).finally(() => {
          approvalReceiptLoading = null;
          if (approvalReceiptRoute === approvalScope()) approvalReceiptsRestored?.();
        });
    }
    return false;
  }
  async function flushApprovalReceipts() {
    if (!approvalReceiptStore || !unsavedApprovalReplies.size) return true;
    if (approvalReceiptWriting) return approvalReceiptWriting;
    const route = approvalScope(), receipts = [...unsavedApprovalReplies.values()].filter(row => row.scope === route).map(row => row.receipt);
    if (!receipts.length) return true;
    approvalReceiptWriting = Promise.resolve().then(() => approvalReceiptStore({ conversationId: conversationId(), receipts }))
      .then(rows => {
        if (approvalScope() !== route || !Array.isArray(rows)) return false;
        for (const row of receipts) unsavedApprovalReplies.delete(`${route}:${row.replyId}`);
        return true;
      }).catch(() => false).finally(() => { approvalReceiptWriting = null; });
    return approvalReceiptWriting;
  }
  function restoreApprovalReplyIds() {
    if (approvalReceiptRoute !== approvalScope()) return;
    for (const row of durableApprovalReplies.values()) {
      const source = document.getElementById(row.sourceId), reply = document.getElementById(row.replyId);
      const user = reply?.matches('.conversation-container') ? reply.querySelector('user-query') : null;
      if (!user) continue;
      const key = nativeId(user, 'user');
      if (!key) continue;
      if (authored(user.querySelector('.query-text') || user) !== row.decision) {
        // Editing a formerly proved control into a real instruction must not
        // inherit its old presentation classification.
        approvalReplyIds.delete(key);
        continue;
      }
      if (!source?.matches('.conversation-container') ||
          !(source.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING)) {
        // Native history may mount an old reply before its source exchange.
        // Its exact scoped click receipt and unchanged decision are already
        // known; quarantine that ID until the source hydrates rather than
        // publishing it as a newly authored task. No text-only match qualifies.
        approvalReplyIds.delete(key);
        provisionalApprovalReplyIds.add(key);
        continue;
      }
      approvalReplyIds.add(key);
    }
  }
  let approvalReplyTimer = null;
  function auditApprovalReply(proof, stage, reason, user = null) {
    const id = node => node?.id?.length === 16 && /^[0-9a-f]{16}$/i.test(node.id) ? node.id.toLowerCase() : null;
    const ended = button => button?.disabled === true || button?.getAttribute('aria-disabled') === 'true' || Boolean(button?.closest('[inert]'));
    const row = { stage, reason, conversationId: proof.conversation, sourceId: proof.sourceId, candidateId: id(user?.closest('.conversation-container')),
      sourceConnected: proof.source?.isConnected === true, cardConnected: proof.card?.isConnected === true,
      sourceMatches: Boolean(proof.source && proof.card?.closest('.conversation-container[id]') === proof.source && id(proof.source) === proof.sourceId),
      routeMatches: proof.route === location.href && proof.conversation === conversationId(), decisionsEnded: ended(proof.allow) && ended(proof.deny),
      preexistingNode: Boolean(user && proof.beforeNodes?.has(user)), preexistingId: Boolean(user && proof.before?.has(nativeId(user, 'user'))),
      decisionMatches: Boolean(user && authored(user.querySelector('.query-text') || user) === proof.decision) };
    const signature = JSON.stringify(row);
    if (proof.lastAudit === signature) return;
    proof.lastAudit = signature;
    proof.lastAuditStage = stage;
    approvalAudit.push({ at: Date.now(), ...row });
    if (approvalAudit.length > 20) approvalAudit.shift();
  }
  function cancelApprovalReplyProofs(reason = 'retired') {
    for (const proof of pendingApprovalReplies) if (proof.lastAuditStage !== 'revoked') auditApprovalReply(proof, 'revoked', reason);
    for (const proof of pendingApprovalReplies) proof.observer?.disconnect();
    pendingApprovalReplies.length = 0;
    provisionalApprovalReplyIds.clear();
    // Retiring transient click observers cannot make a separately restored
    // historical decision become an authored message while its source loads.
    restoreApprovalReplyIds();
    clearTimeout(approvalReplyTimer); approvalReplyTimer = null;
    for (const type of ['beforeinput', 'input', 'keydown', 'click']) document.removeEventListener(type, noteApprovalReplyEdit, true);
  }
  function noteApprovalReplyEdit(event) {
    if (!event.isTrusted) return;
    if (event.target?.closest?.(BOX) || event.target?.closest?.('button') === sendButton()) cancelApprovalReplyProofs('trusted-edit');
  }
  function expectApprovalReply(card, choice) {
    const source = card.node.closest('.conversation-container[id]'), id = conversationId();
    const proof = { source, sourceId: /^[0-9a-f]{16}$/i.test(source?.id || '') ? source.id.toLowerCase() : null,
      card: card.node, allow: card.allowButton, deny: card.denyButton, completed: false,
      decision: choice === 'allow' ? 'Allow' : 'Deny', conversation: id, route: location.href,
      before: new Set(all('user-query').map(node => nativeId(node, 'user'))), beforeNodes: new WeakSet(all('user-query')) };
    if (!id || !source || !proof.sourceId || !card.node.closest('model-response')) {
      auditApprovalReply(proof, 'untracked', 'missing-native-source'); return;
    }
    // Preserve native mutations between recorder scans. A framework can disable
    // both original decisions and remove their card in one render transaction.
    // Final detached state alone is insufficient evidence of that ordering.
    proof.mutations = [];
    proof.observer = new MutationObserver(records => {
      proof.mutations.push(...records);
      if (proof.mutations.length > 64) { proof.overflow = true; proof.mutations.length = 0; proof.observer.disconnect(); }
    });
    proof.observer.observe(source, { subtree: true, childList: true, attributes: true, attributeFilter: ['disabled', 'aria-disabled'] });
    pendingApprovalReplies.push(proof);
    auditApprovalReply(proof, 'click', 'registered');
    if (approvalReplyTimer === null) {
      for (const type of ['beforeinput', 'input', 'keydown', 'click']) document.addEventListener(type, noteApprovalReplyEdit, true);
      approvalReplyTimer = setTimeout(() => cancelApprovalReplyProofs('expired'), 30000);
    }
  }
  function observeApprovalReplies() {
    provisionalApprovalReplyIds.clear();
    restoreApprovalReplyIds();
    const ended = button => button?.disabled === true || button?.getAttribute('aria-disabled') === 'true' || Boolean(button?.closest('[inert]'));
    for (const proof of [...pendingApprovalReplies]) {
      const mutations = [...proof.mutations, ...proof.observer.takeRecords()];
      proof.mutations.length = 0;
      const endedControls = proof.endedControls || (proof.endedControls = new Set());
      for (const mutation of mutations) {
        if (mutation.type === 'attributes' && [proof.allow, proof.deny].includes(mutation.target) && ended(mutation.target))
          endedControls.add(mutation.target);
        if (mutation.type === 'childList' && [...mutation.removedNodes].some(node => node === proof.card || node.contains?.(proof.card))) {
          if (!proof.overflow && endedControls.size === 2 && ended(proof.allow) && ended(proof.deny) &&
              proof.allow.closest('remy-confirmation-card') === proof.card && proof.deny.closest('remy-confirmation-card') === proof.card)
            proof.completed = true;
          break;
        }
      }
      const sameSource = proof.source.isConnected && proof.source.id.toLowerCase() === proof.sourceId;
      const mounted = proof.card.isConnected && proof.card.closest('.conversation-container[id]') === proof.source;
      const originalControls = proof.allow.isConnected && proof.deny.isConnected &&
        proof.allow.closest('remy-confirmation-card') === proof.card && proof.deny.closest('remy-confirmation-card') === proof.card;
      // Gemini disables the exact clicked decisions, then removes that card
      // before mounting its Allow/Deny exchange. Retain only completion actually
      // observed in the original mounted card, never a replacement's state.
      if (sameSource && mounted && originalControls && ended(proof.allow) && ended(proof.deny)) proof.completed = true;
      if (proof.route !== location.href || proof.conversation !== conversationId() || !proof.source.isConnected ||
          !sameSource || (mounted && !originalControls) || (!mounted && (proof.card.isConnected || !proof.completed))) {
        const reason = proof.route !== location.href ? 'route-changed' : proof.conversation !== conversationId() ? 'conversation-changed' :
          !proof.source.isConnected ? 'source-disconnected' : !sameSource ? 'source-id-changed' : mounted && !originalControls ?
          'controls-replaced' : !proof.card.isConnected ? 'card-disconnected' : 'card-reparented';
        cancelApprovalReplyProofs(reason); return;
      }
      if (proof.completed && mounted && (!ended(proof.allow) || !ended(proof.deny))) {
        cancelApprovalReplyProofs('decisions-pending'); return;
      }
      let next = proof.source.nextElementSibling, user = null;
      // Parallel decisions may append consecutive control exchanges. Skip
      // only rows already established by an earlier exact click receipt.
      while (next?.matches('.conversation-container[id]')) {
        user = next.querySelector('user-query');
        if (!user || !(approvalReplyIds.has(nativeId(user, 'user')) || provisionalApprovalReplyIds.has(nativeId(user, 'user')))) break;
        next = next.nextElementSibling; user = null;
      }
      if (!user) { auditApprovalReply(proof, 'waiting', 'candidate-absent'); continue; }
      const key = nativeId(user, 'user');
      if (!key) { auditApprovalReply(proof, 'waiting', 'candidate-unhydrated', user); continue; }
      if (proof.beforeNodes.has(user) || proof.before.has(key) || authored(user.querySelector('.query-text') || user) !== proof.decision) {
        auditApprovalReply(proof, 'revoked', proof.beforeNodes.has(user) ? 'preexisting-node' : proof.before.has(key) ? 'preexisting-id' : 'decision-mismatch', user);
        cancelApprovalReplyProofs(); return;
      }
      if (!proof.completed) {
        auditApprovalReply(proof, 'waiting', 'decisions-pending', user); provisionalApprovalReplyIds.add(key); continue;
      }
      auditApprovalReply(proof, 'matched', 'completed-control', user);
      approvalReplyIds.add(key);
      const replyId = user.closest('.conversation-container')?.id?.toLowerCase();
      const receipt = { sourceId: proof.sourceId, replyId, decision: proof.decision };
      if (validApprovalReceipt(receipt)) {
        durableApprovalReplies.set(replyId, receipt);
        unsavedApprovalReplies.set(`${approvalScope()}:${replyId}`, { scope: approvalScope(), receipt });
        if (durableApprovalReplies.size > 2000) durableApprovalReplies.delete(durableApprovalReplies.keys().next().value);
        if (unsavedApprovalReplies.size > 2000) unsavedApprovalReplies.delete(unsavedApprovalReplies.keys().next().value);
        void flushApprovalReceipts();
      }
      if (approvalReplyIds.size > 2000) approvalReplyIds.delete(approvalReplyIds.values().next().value);
      proof.observer.disconnect();
      pendingApprovalReplies.splice(pendingApprovalReplies.indexOf(proof), 1);
    }
    if (!pendingApprovalReplies.length) cancelApprovalReplyProofs();
  }
  const turns = () => safe(() => {
    observeApprovalReplies();
    let warming = false;
    return all(TURN).filter(shown).filter(node => {
      if (node.tagName === 'USER-QUERY' && (approvalReplyIds.has(nativeId(node, 'user')) || provisionalApprovalReplyIds.has(nativeId(node, 'user')))) return false;
      if (node.tagName === 'USER-QUERY') {
        const value = compact(authored(node.querySelector('.query-text') || node));
        // Historical setup text remains presentation metadata, never a new skill selection.
        warming = value === WARMUP || value === SKILL_WARMUP || value === '@gemini-code ' + WARMUP;
      }
      return !warming;
    }).map(node => ({ node, nodes: [node], role: node.tagName === 'USER-QUERY' ? 'user' : 'assistant',
      id: nativeId(node, node.tagName === 'USER-QUERY' ? 'user' : 'assistant') })).filter(turn => turn.id);
  }, []);
  const messageNode = turn => turn.role === 'user' ? turn.node.querySelector('.query-text,[id^="user-query-content-"]') || turn.node :
    turn.node.querySelector('message-content') || turn.node.querySelector('.model-response-text .markdown,.markdown');
  function messagesIn(turn, index = 0, seen = new Set()) {
    if (!turn?.node?.isConnected || !turn.id) return [];
    const node = messageNode(turn), id = turn.id;
    // Connector status/approval shells are not assistant prose. Never ingest the whole
    // response container while its actual message-content has not mounted yet.
    if (!node) return [];
    if (seen.has(id)) return [];
    seen.add(id);
    const copy = turn.role === 'assistant' ? node.cloneNode(true) : null;
    // Native output has its own exact identity/byte pipeline. Its controls, temporary editor
    // lines and signed media sources must never become assistant prose when Code/Preview flips.
    // Ordinary code-block/code/pre content remains part of the authored reply.
    if (copy) for (const drop of copy.querySelectorAll('action-card,remy-confirmation-card,button,script,style,generated-image,generated-video,immersive-entry-chip')) drop.remove();
    return [{ id, role: turn.role, text: turn.role === 'user' ? authored(node) :
      typeof CLF_GEMINI_MARKDOWN !== 'undefined' ? CLF_GEMINI_MARKDOWN.render(copy) : blockText(copy), turnId: id, node: turn.node, interrupted: false }];
  }
  const messages = () => { const seen = new Set(); return turns().flatMap((turn, at) => messagesIn(turn, at, seen)); };
  /**
   * Gemini's generated-image component declares the attachment index within its exact native
   * response. This is not a DOM-order index. The native exchange and rendered response id must
   * agree before that response/index tuple may own pixels. URLs stay inside this adapter.
   */
  function nativeImageEntries(snapshot = turns()) {
    const conversation = conversationId();
    if (!conversation) return [];
    const entries = [];
    for (const turn of snapshot.filter(row => row.role === 'assistant').slice(-64)) {
      const roots = all('[id^="model-response-message-contentr_"]', turn.node);
      if (roots.length !== 1) continue;
      const response = /^model-response-message-contentr_([0-9a-f]{16})$/i.exec(roots[0].id);
      if (!response || turn.id !== `gemini:${conversation}:assistant:${response[1].toLowerCase()}`) continue;
      const cards = all('generated-image single-image.generated-image[data-image-attachment-index]', roots[0]);
      const indexes = cards.map(card => card.getAttribute('data-image-attachment-index'));
      for (const card of cards.slice(0, 16)) {
        const index = card.getAttribute('data-image-attachment-index');
        if (!/^(?:0|[1-9]\d{0,3})$/.test(index || '') || indexes.filter(value => value === index).length !== 1) continue;
        const images = all('img.image', card);
        // Download may be hover-hidden. Its native ownership, not its visibility, proves the
        // generated-image surface; ordinary reply images and uploaded images never qualify.
        if (images.length !== 1 || all('button[aria-label="Download full-sized image"]', card).length !== 1) continue;
        const node = images[0];
        if (!node.isConnected || node.closest('single-image') !== card || card.closest('model-response') !== turn.node) continue;
        const width = node.naturalWidth, height = node.naturalHeight;
        const complete = Boolean(turn.node.querySelector('.response-footer.complete')) && !pendingApprovalIn(turn.node);
        entries.push({ node, card, root: turn.node, image: { messageId: turn.id, assetId: `image_${index}`,
          providerRole: 'assistant', providerChannel: 'final', providerStatus: complete ? 'finished_successfully' : 'in_progress',
          ...(width > 0 ? { width } : {}), ...(height > 0 ? { height } : {}) } });
      }
    }
    return entries;
  }
  function nativeVideoEntries(snapshot = turns()) {
    const conversation = conversationId();
    if (!conversation) return [];
    const entries = [];
    for (const turn of snapshot.filter(row => row.role === 'assistant').slice(-64)) {
      const roots = all('[id^="model-response-message-contentr_"]', turn.node);
      if (roots.length !== 1) continue;
      const response = /^model-response-message-contentr_([0-9a-f]{16})$/i.exec(roots[0].id);
      if (!response || turn.id !== `gemini:${conversation}:assistant:${response[1].toLowerCase()}`) continue;
      // Gemini exposes one native generated video per response, without a file id. The
      // response-scoped singleton is the identity; ambiguous/multiple resources fail closed.
      const cards = all('generated-video', roots[0]);
      if (cards.length !== 1 || cards[0].closest('model-response') !== turn.node ||
          all('button[aria-label="Download video"]', cards[0]).length !== 1) continue;
      const nodes = all('video-player video', cards[0]);
      if (nodes.length !== 1 || !nodes[0].isConnected) continue;
      const node = nodes[0]; let mimeType;
      try {
        const url = new URL(node.currentSrc || node.src, location.href);
        if (url.protocol !== 'https:' || url.origin !== 'https://contribution.usercontent.google.com' || url.pathname !== '/download') continue;
        const extension = /\.(mp4|webm)$/i.exec(url.searchParams.get('filename') || '')?.[1]?.toLowerCase();
        mimeType = extension === 'mp4' ? 'video/mp4' : extension === 'webm' ? 'video/webm' : null;
        const declared = node.getAttribute('type') || node.querySelector('source[type]')?.getAttribute('type');
        if (!mimeType || (declared && declared !== mimeType)) continue;
      } catch { continue; }
      const complete = Boolean(turn.node.querySelector('.response-footer.complete')) && !pendingApprovalIn(turn.node);
      entries.push({ node, video: { messageId: turn.id, assetId: 'video', mimeType,
        providerRole: 'assistant', providerChannel: 'final', providerStatus: complete ? 'finished_successfully' : 'in_progress',
        ...(node.videoWidth > 0 ? { width: node.videoWidth } : {}), ...(node.videoHeight > 0 ? { height: node.videoHeight } : {}),
        ...(Number.isFinite(node.duration) && node.duration > 0 ? { durationMs: Math.round(node.duration * 1000) } : {}) } });
    }
    return entries;
  }
  function nativeCanvasEntries(snapshot = turns()) {
    const conversation=conversationId();if(!conversation)return[];
    return snapshot.filter(turn=>turn.role==='assistant').slice(-16).flatMap(turn=>{
      const roots=all('[id^="model-response-message-contentr_"]',turn.node),id=roots.length===1?/^model-response-message-contentr_([0-9a-f]{16})$/i.exec(roots[0].id)?.[1]?.toLowerCase():null;
      if(!id||turn.id!==`gemini:${conversation}:assistant:${id}`)return[];
      const cards=all('immersive-entry-chip inline-preview',roots[0]);if(cards.length!==1)return[];
      const card=cards[0];if(!card.querySelector('mat-button-toggle[value="code"] button')||!card.querySelector('mat-button-toggle[value="preview"] button'))return[];
      return[{messageId:turn.id,nativeSurface:'canvas',title:text(card.querySelector('.title')).slice(0,200)||'Canvas',kind:'web',entrypoint:'index.html'}];
    });
  }
  const nativeOutputs = snapshot => ({ images: nativeImageEntries(snapshot).map(entry => entry.image), videos: nativeVideoEntries(snapshot).map(entry => entry.video), artifacts:nativeCanvasEntries(snapshot) });
  function nativeVideoEntry(video) {
    const found = nativeVideoEntries().filter(entry => entry.video.messageId === video.messageId && entry.video.assetId === video.assetId && entry.video.mimeType === video.mimeType);
    return found.length === 1 ? found[0] : null;
  }
  const nativeVideoNode = video => nativeVideoEntry(video)?.node ?? null;
  const nativeVideoDescriptorCurrent = video => nativeVideoEntry(video)?.video ?? null;
  const capturedCanvases = new WeakSet();
  async function readNativeArtifacts(current = () => true) {
    const conversation = conversationId(), route = location.href, results = [];
    if (!conversation || generating() || !current()) return results;
    for (const turn of turns().filter(row=>row.role==='assistant').slice(-16)) {
      const roots=all('[id^="model-response-message-contentr_"]',turn.node);
      const responseId=roots.length===1?/^model-response-message-contentr_([0-9a-f]{16})$/i.exec(roots[0].id)?.[1]?.toLowerCase():null;
      if(!responseId || turn.id!==`gemini:${conversation}:assistant:${responseId}` || !turn.node.querySelector('.response-footer.complete') || pendingApprovalIn(turn.node))continue;
      const cards=all('immersive-entry-chip inline-preview',roots[0]);
      if(cards.length!==1 || capturedCanvases.has(cards[0]))continue;
      const card=cards[0], code=unique(all('mat-button-toggle[value="code"] button',card)), preview=unique(all('mat-button-toggle[value="preview"] button',card));
      if(!enabled(code)||!enabled(preview)||!card.querySelector('button[aria-label="Changes saved"]'))continue;
      const wasPreview=preview.getAttribute('aria-checked')==='true'; let interrupted=false;
      const touched=event=>{if(event.isTrusted)interrupted=true};
      const owns=()=>current()&&!interrupted&&location.href===route&&conversationId()===conversation&&card.isConnected&&card.closest('model-response')===turn.node&&!generating();
      document.addEventListener('pointerdown',touched,true);document.addEventListener('keydown',touched,true);
      try {
        if(wasPreview)code.click();
        if(!await waitFor(()=>code.getAttribute('aria-checked')==='true'&&card.querySelector('.monaco-editor'),owns,3000))continue;
        const reply=await chrome.runtime.sendMessage({type:'native_canvas_snapshot',conversationId:conversation,responseId});
        const snapshot=reply?.ok&&reply.snapshot;
        if(owns()&&snapshot?.messageId===turn.id&&snapshot.nativeSurface==='canvas'&&snapshot.kind==='web'&&snapshot.entrypoint==='index.html'&&['unsupported','oversized'].includes(snapshot.error)){
          results.push({...snapshot,status:'failed',files:undefined});capturedCanvases.add(card);continue;
        }
        if(!owns()||!snapshot||snapshot.messageId!==turn.id||snapshot.nativeSurface!=='canvas'||snapshot.kind!=='web'||snapshot.entrypoint!=='index.html'||
            snapshot.files?.length!==1||snapshot.files[0].path!=='index.html'||typeof snapshot.files[0].text!=='string'||!snapshot.files[0].text||snapshot.files[0].text.length>240_000)continue;
        results.push(snapshot);capturedCanvases.add(card);
      } finally {
        if(wasPreview&&owns()&&code.getAttribute('aria-checked')==='true')preview.click();
        document.removeEventListener('pointerdown',touched,true);document.removeEventListener('keydown',touched,true);
      }
      if(results.length>=4||!current())break;
    }
    return results;
  }
  function nativeImageEntry(image) {
    const found = nativeImageEntries().filter(entry => entry.image.messageId === image.messageId && entry.image.assetId === image.assetId);
    return found.length === 1 ? found[0] : null;
  }
  const nativeImageNode = image => nativeImageEntry(image)?.node ?? null;
  async function exportNativeImage(message, current = () => true) {
    const conversation = conversationId(), entry = nativeImageEntry(message);
    if (!conversation || message.conversationId !== conversation || !current()) return { error: 'not_open' };
    if (!entry || entry.image.providerStatus !== 'finished_successfully') return { error: 'not_rendered' };
    const { node } = entry, source = node.currentSrc || node.src, width = node.naturalWidth, height = node.naturalHeight;
    if (!node.complete || !width || !height) return { error: 'not_rendered' };
    if (width * height > 30_000_000) return { error: 'too_large' };
    const valid = () => current() && conversationId() === conversation && nativeImageNode(message) === node &&
      node.isConnected && (node.currentSrc || node.src) === source && node.naturalWidth === width && node.naturalHeight === height;
    try {
      // Gemini revokes the rendered blob URL after loading. Canvas reads those exact loaded
      // pixels without fetching a private/signed endpoint. This is explicitly a rendered PNG,
      // not a claim that the provider's separate full-size download was retrieved.
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const context = canvas.getContext('2d'); if (!context || !valid()) return { error: 'identity_changed' };
      context.drawImage(node, 0, 0);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      if (!valid()) return { error: 'identity_changed' };
      if (!blob || blob.type !== 'image/png' || !blob.size) return { error: 'not_image' };
      if (blob.size > 25 * 1024 * 1024) return { error: 'too_large' };
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (!valid()) return { error: 'identity_changed' };
      let binary = '';
      for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
      return { data: btoa(binary), representation: 'rendered' };
    } catch { return { error: 'not_image' }; }
  }
  const turnIdOf = node => { const turn = node?.closest?.(TURN);
    return turn && !(turn.tagName === 'USER-QUERY' && (approvalReplyIds.has(nativeId(turn, 'user')) || provisionalApprovalReplyIds.has(nativeId(turn, 'user'))))
      ? nativeId(turn, turn.tagName === 'USER-QUERY' ? 'user' : 'assistant') : null; };
  const messageIdOf = turnIdOf;
  const composerSubmitReady = () => composerWritable() && !generating() && !composerAuthoredText() && !hasComposerAttachments();
  function insertPrompt(value, mode = false, failure = null, observeEdit = null) {
    return safe(() => {
      const box = composer();
      if (!box || !composerWritable()) { failure?.('editor-not-writable'); return false; }
      const existing = composerAuthoredText();
      if (existing && mode !== true && mode !== 'append' && compact(existing) !== compact(value)) { failure?.('existing-draft'); return false; }
      if (compact(existing) === compact(value) && mode !== 'append') return true;
      const next = mode === 'append' ? existing + String(value) : String(value);
      const mention = provenMention(box);
      box.focus();
      const selection = document.getSelection(), range = document.createRange();
      range.selectNodeContents(box);
      if (mention && next) range.setStartAfter(mention.node);
      selection.removeAllRanges(); selection.addRange(range);
      // One editor-native edit lets Gemini's rich editor update its internal document.
      const inserted = mention && next ? ' ' + next : next;
      const expectedVisible = (mention && next ? `@${mention.name} ` : '') + next;
      const applied = () => compact(blockText(box)) === compact(expectedVisible);
      const reported = document.execCommand?.('insertText', false, inserted);
      observeEdit?.({ reported: reported ?? null, applied: applied() });
      // Gemini can handle beforeinput and mutate Quill, then return false from
      // execCommand. Replacing that successful edit would destroy its native
      // menu/internal selection. The rendered result is the deciding evidence.
      if (!reported && !applied()) {
        if (mention && next) { range.deleteContents(); range.insertNode(document.createTextNode(inserted)); }
        else box.textContent = next;
        box.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: inserted }));
      }
      if (!next) nativeMentions.delete(box);
      if (mention && next && !confirmedMention(mention.name, box)) return false;
      return applied();
    }, false);
  }
  function clearPromptExact(expected) {
    return compact(composerAuthoredText()) === compact(stripControl(expected)) && insertPrompt('', true);
  }
  function captureComposerDraft(expected, current = () => true) {
    let box = composer(), retired = false, leasedAttachments = null;
    const owns = () => !retired && current() && box === composer() && box?.isConnected &&
      (compact(authored(box)) === compact(stripControl(expected)) || transitionOwns(box, expected)) &&
      (!leasedAttachments || attachmentRows().length === leasedAttachments.length &&
        leasedAttachments.every(file => file.node.isConnected && attachmentRows().includes(file.node) && attachmentName(file.node) === file.name));
    return { current: owns, clear: async () => owns() && clearPromptExact(expected), withdraw: () => { if (!owns()) return false; retired = true; return true; },
      dispose: () => { retired = true; }, attachments: nodes => { leasedAttachments = nodes.map(node => ({ node, name: attachmentName(node) })); }, rebind: () => {
        if (retired || !current() || compact(composerAuthoredText()) !== compact(stripControl(expected))) return false;
        box = composer(); return true;
      } };
  }
  let ownNames = [], ownApps = [];
  function setConnectorNames(names) {
    const next = [names?.core, names?.desktop, names?.plugins].filter(name => typeof name === 'string' && name.length > 0 && name.length <= 160);
    if (!next.length) return false;
    const nextNames = [...new Set(next)];
    if (JSON.stringify(nextNames) !== JSON.stringify(ownNames)) approvalMismatch = null;
    ownNames = nextNames; return true;
  }
  const connectorNames = () => [...ownNames];
  const setConnectorApps = value => { ownApps = Object.entries(value || {}).flatMap(([surface, entries]) =>
    (Array.isArray(entries) ? entries : []).filter(entry => typeof entry?.appId === 'string').map(entry => ({ ...entry, surface }))); return true; };
  const connectorApps = () => ownApps.map(app => ({ ...app }));
  let bindingResolver = null;
  const setBindingResolver = resolver => { bindingResolver = typeof resolver === 'function' ? resolver : null; };
  async function bindingFor(id, current) {
    if (!id || !bindingResolver) return null;
    const opening = preparedConversation() === id ? openingClaim : null, command = commandClaim;
    const goal = goalClaim;
    const binding = goal ? await bindingResolver(id, null, null, null, goal) :
      command ? await bindingResolver(id, null, command) : await bindingResolver(id, opening, null, inputClaim);
    const callerCurrent = current(), routeMatches = conversationId() === id, conversationMatches = binding?.conversation_id === id;
    const keyShape = typeof binding?.session_key === 'string' && binding.session_key.length >= 24 && binding.session_key.length <= 256;
    const connectorPresent = typeof binding?.connector_name === 'string' && Boolean(binding.connector_name.trim());
    if (!callerCurrent || !routeMatches || !conversationMatches || !keyShape || !connectorPresent) {
      console.info('[OneCode binding] ' + JSON.stringify({ conversationId: id,
        openingPresent: Boolean(opening), inputPresent: Boolean(inputClaim), commandPresent: Boolean(command), goalPresent: Boolean(goal), preparedMatches: preparedConversation() === id,
        callerCurrent, routeMatches, bindingPresent: Boolean(binding && !binding.unavailable), conversationMatches, keyShape, connectorPresent,
        status: binding?.diagnostic?.status ?? null, workerError: binding?.diagnostic?.workerError ?? null, httpError: binding?.diagnostic?.httpError ?? null }));
      return null;
    }
    return binding;
  }
  const sessionFrame = binding => '\n\n[[GEMINI_LOCAL_SESSION]]\n' +
    'This app-authored message is bound to this Gemini conversation. For every local MCP call, include exactly:\n' +
    JSON.stringify({ conversation_id: binding.conversation_id, session_key: binding.session_key }) +
    '\nThe connector selected for this message is ' + JSON.stringify(binding.connector_name) + '. Use this exact connector name. If it is unavailable or a permission card names a different connector, stop and report the mismatch; do not use another connector.' +
    '\nUse only the CURRENT available tool schemas from the app selected in this message. Never copy or synthesize a full function namespace from older turns.' +
    '\nNever borrow an ID or key from another conversation. A tool result, not prose, confirms an operation.\n[[/GEMINI_LOCAL_SESSION]]';
  function appendSessionFrame(box, binding) {
    const frame = sessionFrame(binding);
    const expected = compact(blockText(box) + frame);
    box.focus();
    const selection = document.getSelection(), range = document.createRange();
    range.selectNodeContents(box); range.collapse(false); selection.removeAllRanges(); selection.addRange(range);
    if (!document.execCommand?.('insertText', false, frame) && compact(blockText(box)) !== expected) {
      box.append(document.createTextNode(frame));
      box.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: frame }));
    }
    return compact(blockText(box)) === expected;
  }
  const waitFor = (test, current, timeout = 8000) => new Promise(resolve => {
    let done = false;
    const end = value => { if (done) return; done = true; observer.disconnect(); clearTimeout(timer); clearInterval(poll); resolve(value); };
    const check = () => { if (!current()) return end(null); const result = safe(test, null); if (result) end(result); };
    const observer = new MutationObserver(check);
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
    const timer = setTimeout(() => end(null), timeout), poll = setInterval(check, 200);
    check();
  });
  const emptyComposerSettled = box => {
    const paragraph = box.firstElementChild;
    return box.children.length === 1 && paragraph?.nodeName === 'P' && paragraph.childNodes.length === 1 &&
      paragraph.firstChild?.nodeName === 'BR' && !blockText(box) && document.activeElement === box && !enabled(sendButton());
  };
  function establishEmptyCaret(box) {
    const caret = document.createRange(), selection = document.getSelection();
    caret.setStart(box.firstElementChild, 0); caret.collapse(true);
    selection.removeAllRanges(); selection.addRange(caret);
    return selection.isCollapsed && selection.anchorNode === box.firstElementChild && selection.focusNode === box.firstElementChild &&
      selection.anchorOffset === 0 && selection.focusOffset === 0;
  }
  function confirmedMention(name, box = composer()) {
    if (!box) return false;
    if (provenMention(box)?.name === name) return true;
    return all(MENTION, box).some(node => text(node).trim().replace(/^@/, '') === name || node.getAttribute('data-mention-name') === name);
  }
  async function selectNativeMention(name, current, explain = null, replacement = null, onReady = null, menuTimeoutMs = 8000) {
    const requestedName = name;
    const sameName = candidate => candidate === requestedName;
    const refused = reason => { explain?.(reason); return false; };
    if (!name || !current()) return refused('connector-preparation-revoked');
    const box = composer();
    if (!box || !composerWritable()) return refused('connector-editor-unavailable');
    if (replacement === null && confirmedMention(name, box)) return true;
    const original = composerAuthoredText();
    const restoredText = replacement === null ? original : replacement;
    const route = location.href;
    const edit = { expected: original, route, html: box.innerHTML, normalizationText: null, revoked: false };
    composerTransitions.set(box, edit);
    const snapshot = (normalization = false) => {
      edit.html = box.innerHTML;
      edit.normalizationText = normalization ? blockText(box) : null;
    };
    let performingOwnEdit = false;
    const ownEdit = operation => { performingOwnEdit = true; try { return operation(); } finally { performingOwnEdit = false; } };
    const trustedEdit = event => { if (event.isTrusted && !performingOwnEdit) edit.revoked = true; };
    box.addEventListener('beforeinput', trustedEdit, true);
    box.addEventListener('input', trustedEdit, true);
    const owns = () => composer() === box && location.href === route && transitionOwns(box, original);
    const revokedReason = () => composer() !== box ? 'connector-editor-replaced' : location.href !== route ? 'connector-route-changed' :
      edit.revoked ? 'connector-user-edit' : !transitionOwns(box, original) ? 'connector-draft-changed' :
      !current() ? 'connector-lifetime-revoked' : 'connector-preparation-revoked';
    let awaitingToken = false, selected = false, handedOff = false;
    const beforeStrong = new Set();
    const selectionCurrent = () => {
      // Gemini's observed token has no attributes. It is proof only after our
      // exact native menu click, while the empty selector contains this token alone.
      if (awaitingToken && !edit.revoked && composer() === box && location.href === route) {
        const strong = leadingStrong(box, name);
        if (strong && !beforeStrong.has(strong) && compact(blockText(box)) === `@${name}`) {
          nativeMentions.set(box, { name, node: strong, route }); snapshot(true);
        } else if (confirmedMention(name, box) && !composerAuthoredText()) snapshot(true);
      }
      return owns() && current();
    };
    try {
    // Gemini opens its menu only from a settled empty Quill document. Both
    // nonempty -> '@' and immediate clear -> '@' fail in the native sequence
    // probes. Wait for its rendered empty paragraph and empty Send UI, not time.
    let clearEdit = null;
    if (!ownEdit(() => insertPrompt('', true, null, result => { clearEdit = result; }))) return refused('connector-editor-clear-refused');
    snapshot(true);
    const emptyReady = await waitFor(() => emptyComposerSettled(box), selectionCurrent);
    if (!emptyReady) {
      if (!selectionCurrent()) return refused(revokedReason());
      const paragraph = box.firstElementChild, caret = document.getSelection(), copy = box.cloneNode(true);
      for (const element of [copy, ...copy.querySelectorAll('*')]) for (const attribute of [...element.attributes]) element.removeAttribute(attribute.name);
      const walker = document.createTreeWalker(copy, NodeFilter.SHOW_TEXT);
      let leaf;
      while ((leaf = walker.nextNode())) leaf.textContent = leaf.textContent.length ? `[text:${leaf.textContent.length}]` : '';
      console.info('[OneCode empty selector] ' + JSON.stringify({
        clearEdit, htmlSkeleton: copy.innerHTML.slice(0, 1500), textLength: blockText(box).length, domTextLength: box.textContent.length,
        children: [...box.childNodes].slice(0, 12).map(node => node.nodeName), elementCount: box.children.length,
        paragraphTag: paragraph?.nodeName || null, paragraphChildren: paragraph ? [...paragraph.childNodes].slice(0, 12).map(node => node.nodeName) : [],
        anchorNode: caret?.anchorNode?.nodeName || null, anchorOffset: caret?.anchorOffset ?? null,
        focusNode: caret?.focusNode?.nodeName || null, focusOffset: caret?.focusOffset ?? null, collapsed: caret?.isCollapsed ?? null,
        anchorIsParagraph: Boolean(paragraph && caret?.anchorNode === paragraph), focusIsParagraph: Boolean(paragraph && caret?.focusNode === paragraph),
        hasFocus: document.hasFocus(), editorFocused: document.activeElement === box, activeTag: document.activeElement?.nodeName || null,
        clipboardFocused: Boolean(document.activeElement?.classList.contains('ql-clipboard')),
        editorSame: composer() === box, routeSame: location.href === route, snapshotOwned: transitionOwns(box, original), trustedEditRevoked: edit.revoked,
        sendPresent: Boolean(sendButton()), sendEnabled: enabled(sendButton())
      }));
      return refused('connector-empty-not-settled');
    }
    // Quill may normalize the document while retaining our clearing selection
    // as DIV/0 -> DIV/1. It is still our unchanged empty draft. Establish and
    // prove the native paragraph caret instead of waiting for that stale range.
    if (!ownEdit(() => establishEmptyCaret(box)) || !selectionCurrent())
      return refused(selectionCurrent() ? 'connector-empty-caret-unconfirmed' : revokedReason());
    // Chromium may reject execCommand for this editor. Use the same verified
    // input-event fallback as task insertion, then require Gemini's real menu.
    let selectorEdit = null;
    if (!ownEdit(() => insertPrompt('@', true, null, result => { selectorEdit = result; }))) return refused('connector-selector-insert-refused');
    snapshot(true);
    if (compact(blockText(box)) !== '@') return refused('connector-selector-text-unconfirmed');
    const choices = await waitFor(() => {
      const native = all('button.at-mentions-v2-item[role="menuitem"][aria-label]')
        .filter(node => shown(node) && sameName(node.getAttribute('aria-label')));
      const candidates = native.length ? native : all('[role="option"],[role="menuitem"],mat-option').filter(node => shown(node) &&
        (sameName(node.getAttribute('aria-label') || '') || sameName(compact(text(node)).replace(/^@/, ''))));
      // A provider dropdown may use buttons rather than ARIA options; only outside transcript/editor.
      if (!candidates.length) candidates.push(...all('[role="listbox"] button,.cdk-overlay-pane button').filter(node =>
        shown(node) && !node.closest(`${TURN},${BOX}`) && sameName(compact(text(node)).replace(/^@/, ''))));
      return candidates.length === 1 ? candidates[0] : null;
    }, selectionCurrent, menuTimeoutMs);
    if (!choices) {
      if (!selectionCurrent()) return refused(revokedReason());
      const items = all('.at-mentions-v2-item'), exact = items.filter(node => node.getAttribute('aria-label') === name);
      const caret = document.getSelection();
      console.info('[OneCode selector] ' + JSON.stringify({
        connector: name, items: items.length, exact: exact.length, shown: exact.filter(shown).length,
        excluded: exact.map(node => ({
          owned: Boolean(node.closest(OWN)), hidden: Boolean(node.closest('[hidden]')),
          ariaHidden: Boolean(node.closest('[aria-hidden="true"]')), inert: Boolean(node.closest('[inert]')),
          rects: node.getClientRects().length, display: getComputedStyle(node).display, visibility: getComputedStyle(node).visibility
        })),
        editorOnlyAt: blockText(box) === '@', anchorNode: caret?.anchorNode?.nodeName || null, anchorOffset: caret?.anchorOffset ?? null,
        focusNode: caret?.focusNode?.nodeName || null, focusOffset: caret?.focusOffset ?? null, collapsed: caret?.isCollapsed ?? null,
        hasFocus: document.hasFocus(), editorFocused: document.activeElement === box, edit: selectorEdit
      }));
      return refused('connector-menu-unavailable');
    }
    if (!selectionCurrent() || !choices.isConnected) return refused(revokedReason());
    name = choices.getAttribute('aria-label') || compact(text(choices)).replace(/^@/, '');
    all('strong', box).forEach(node => beforeStrong.add(node));
    awaitingToken = true;
    choices.scrollIntoView?.({ block: 'nearest' }); ownEdit(() => choices.click());
    selected = Boolean(await waitFor(() => confirmedMention(name, box) && !composerAuthoredText(), selectionCurrent, 5000));
    if (!selected) return refused(selectionCurrent() ? 'connector-token-unconfirmed' : revokedReason());
    if (!selectionCurrent()) return refused(revokedReason());
    const tokenProof = provenMention(box);
    if (!tokenProof) return refused('connector-token-unconfirmed');
    awaitingToken = false;
    let restoreEdit = null;
    const restored = ownEdit(() => insertPrompt(restoredText, true, null, result => { restoreEdit = result; }));
    // Native Quill briefly expands the same bold token through the inserted
    // task, then restores its exact original text. A verified full edit can
    // remain provisional in this owned transition, but cannot authorize Send.
    if (!restored && (restoreEdit?.applied !== true || !tokenProof.node.isConnected || !box.contains(tokenProof.node)))
      return refused('connector-task-restore-refused');
    snapshot(true);
    const restoreCurrent = () => selectionCurrent() && tokenProof.node.isConnected && box.contains(tokenProof.node) &&
      compact(blockText(box)) === compact(`@${name} ${restoredText}`);
    const taskReady = await waitFor(() => provenMention(box)?.node === tokenProof.node &&
      compact(composerAuthoredText()) === compact(restoredText), restoreCurrent, 8000);
    if (!taskReady) return refused(restoreCurrent() ? 'connector-task-restore-unconfirmed' : revokedReason());
    snapshot();
    if (!current() || !confirmedMention(name, box) || compact(composerAuthoredText()) !== compact(restoredText)) return false;
    return onReady ? await onReady(box, selectionCurrent, () => { handedOff = true; }) : true;
    } finally {
      // Never overwrite a foreign edit. This also removes a raw app-owned '@'
      // after a failed selection, so a safe preparation retry sees its own task.
      if (!handedOff && owns() && current() && compact(composerAuthoredText()) !== compact(original)) {
        if (!selected) nativeMentions.delete(box);
        ownEdit(() => insertPrompt(original, true));
      }
      box.removeEventListener('beforeinput', trustedEdit, true);
      box.removeEventListener('input', trustedEdit, true);
      if (composerTransitions.get(box) === edit) composerTransitions.delete(box);
    }
  }
  const selectConnector = (name, current, explain = null) => selectNativeMention(name, current, explain);
  async function sendControlledWarmup(box, submitted, warmup, current, explain, adoptEditor = null, withOwnEdit = null) {
    if (warmup === SKILL_WARMUP) {
      // A pasted @name does not activate Gemini's native Skill state. Select
      // its actual native option/token, then spend the same tool-free warm-up
      // Send while this selection owner still holds the original app draft.
      const opening = openingClaim, command = commandClaim, attachments = attachmentRows();
      const ownsClaim = () => current() && openingClaim === opening && commandClaim === command && Boolean(opening || command) &&
        attachmentRows().length === attachments.length && attachmentRows().every((node, index) => node === attachments[index]);
      let clicked = false, refusal = null;
      // Guidance is optional; a missing/renamed Skill must not spend the full
      // required-Core lookup budget before the ordinary tool-free warm-up.
      const selected = await selectNativeMention('onecode-gemini', ownsClaim, reason => { refusal = reason; }, WARMUP, async (editor, owns, handedOff) => {
        const ready = await waitFor(() => enabled(sendButton()) && composerAuthoredText() === WARMUP &&
          provenMention(editor)?.name === 'onecode-gemini' && sendButton(), owns, 30000);
        if (!ready || !owns() || composerAuthoredText() !== WARMUP || provenMention(editor)?.name !== 'onecode-gemini') {
          refusal = 'warmup-skill-send-not-ready'; return false;
        }
        cancelApprovalReplyProofs('new-send'); handedOff(); clicked = true; ready.click(); return true;
      }, 2500);
      if (selected) return SKILL_WARMUP;
      // A missing native Skill is guidance unavailability, not MCP authority.
      // Continue only after the unchanged original app draft was restored and
      // no native Send occurred. Never recover across a user edit or lost claim.
      if (clicked || !ownsClaim() || compact(composerAuthoredText()) !== compact(submitted)) {
        explain?.(refusal || 'warmup-skill-preparation-revoked'); return false;
      }
      console.info('[OneCode Skill] ' + JSON.stringify({ outcome: 'unavailable', fallback: 'tool-free-warmup' }));
      warmup = WARMUP;
    }
    const route = location.href;
    const edit = { expected: submitted, route, html: box.innerHTML, normalizationText: null, revoked: false };
    composerTransitions.set(box, edit);
    let performingOwnEdit = false, clicked = false, cleared = false, staged = false, rebound = false;
    const opening = openingClaim, command = commandClaim, attachments = attachmentRows();
    const sameAttachments = () => { const rows = attachmentRows(); return rows.length === attachments.length && rows.every((node, index) => node === attachments[index]); };
    const ownEdit = operation => { performingOwnEdit = true; try { return withOwnEdit ? withOwnEdit(operation) : operation(); } finally { performingOwnEdit = false; } };
    const snapshot = () => { edit.html = box.innerHTML; edit.normalizationText = blockText(box); };
    const trustedEdit = event => { if (event.isTrusted && !performingOwnEdit && event.target?.closest?.(BOX)) edit.revoked = true; };
    const owns = () => {
      const replacement = composer();
      // Gemini can remount its fresh editor after staging the controlled warm-up,
      // before enabling Send. Transfer this same transition once, only while the
      // exact opening/command, route, text and attachments remain unchanged. A
      // human edit or an existing conversation cannot acquire this preparation.
      if ((cleared || staged) && !rebound && !clicked && !box.isConnected && replacement?.isConnected &&
          Boolean(opening || command) && openingClaim === opening && commandClaim === command &&
          location.href === route && !conversationId() && transitionOwns(box, submitted) &&
          composerWritable() && composerAuthoredText() === (staged ? warmup : '') &&
          (staged || (!hasComposerAttachments() && !enabled(sendButton()))) &&
          sameAttachments() &&
          adoptEditor?.(replacement) === true) {
        if (composerTransitions.get(box) === edit) composerTransitions.delete(box);
        box = replacement; rebound = true; snapshot(); composerTransitions.set(box, edit);
        if (!staged && document.activeElement === document.body) ownEdit(() => box.focus({ preventScroll: true }));
      }
      return location.href === route && composer() === box && sameAttachments() && transitionOwns(box, submitted) && current();
    };
    const refused = reason => { explain?.(reason); return false; };
    document.addEventListener('beforeinput', trustedEdit, true); document.addEventListener('input', trustedEdit, true);
    try {
      // A DOM replacement is not proof that Gemini's Send model has caught up.
      // The real task must first leave that model through observed native empty
      // UI. Only then can the controlled, tool-free warm-up become submit-ready.
      if (!owns() || !ownEdit(() => insertPrompt('', true))) return refused('warmup-editor-clear-refused');
      snapshot(); cleared = true;
      if (!await waitFor(() => emptyComposerSettled(box), owns)) return refused('warmup-empty-not-settled');
      if (!ownEdit(() => establishEmptyCaret(box)) || !owns()) return refused('warmup-caret-unconfirmed');
      if (!ownEdit(() => insertPrompt(warmup, true))) return refused('warmup-not-ready');
      snapshot(); staged = true;
      const readyDeadline = Date.now() + 30000;
      const ready = await waitFor(() => enabled(sendButton()) && composerAuthoredText() === warmup && sendButton(), owns, 30000);
      if (ready) await waitFor(() => {
        if (clicked) return true;
        const button = sendButton();
        if (Date.now() >= readyDeadline || !enabled(button) || button !== sendButton() ||
            composerAuthoredText() !== warmup || !owns()) return null;
        // The readiness await may have outlived its native Send control. Commit
        // the first click only inside this current-control check, within the
        // original budget and draft lease. Once dispatch starts, a missing
        // receipt or a native-handler error cannot earn another click.
        cancelApprovalReplyProofs('new-send'); clicked = true; ownEdit(() => button.click());
        return true;
      }, owns, Math.max(0, readyDeadline - Date.now()));
      if (!clicked) {
        const reason = composer() !== box ? 'warmup-editor-replaced' : location.href !== route ? 'warmup-route-changed' :
          !current() ? 'warmup-lifetime-changed' : !sameAttachments() ? 'warmup-attachments-present' : composerAuthoredText() !== warmup ? 'warmup-text-changed' :
          !transitionOwns(box, submitted) ? 'warmup-draft-lease-changed' : 'warmup-send-not-ready';
        console.info('[OneCode warmup] ' + JSON.stringify({ reason, editorSame: composer() === box,
          editorConnected: box.isConnected, routeMatches: location.href === route, callerCurrent: current(),
          textMatches: composerAuthoredText() === warmup, leaseCurrent: transitionOwns(box, submitted),
          readyObserved: Boolean(ready), sendEnabled: enabled(sendButton()) }));
        return refused(reason);
      }
      return warmup;
    } finally {
      // A failed preparation never restores over a foreign edit or a changed
      // route. After a click, only the native warm-up receipt can advance it.
      if (!clicked && owns()) ownEdit(() => insertPrompt(submitted, true));
      document.removeEventListener('beforeinput', trustedEdit, true); document.removeEventListener('input', trustedEdit, true);
      if (composerTransitions.get(box) === edit) composerTransitions.delete(box);
    }
  }
  function warmupQuestionKey(row) {
    const id = row && nativeId(row, 'user');
    if (!id || /:document-\d+$/.test(id)) return null;
    const prefix = `gemini:${conversationId() || 'fresh'}:user:`;
    return id.startsWith(prefix) ? id.slice(prefix.length) : null;
  }
  function recoveredWarmupConversationCurrent(held) {
    const id = conversationId();
    if (held.nativeConversation && id !== held.nativeConversation) return false;
    if (id && !held.nativeConversation) held.nativeConversation = id;
    return true;
  }
  function retainRecoveredWarmupRow(held, row, value) {
    if (!held?.recovering || held.edited || !held.current() ||
        (held.kind === 'command' ? commandClaim : openingClaim) !== held.claim ||
        Date.now() >= held.deadline || !warmupRouteCurrent(held.route)) return;
    if (!recoveredWarmupConversationCurrent(held) || !row || value !== held.warmup) return;
    const key = warmupQuestionKey(row), id = conversationId();
    if (!key || (held.questionKey && key !== held.questionKey) ||
        (held.nativeConversation && id !== held.nativeConversation)) return;
    // Native placeholders cannot pin identity. A replacement may retain only
    // this positive native question; its first real conversation stays fixed.
    held.questionKey = key;
    if (!held.questionId) held.questionId = nativeId(row, 'user');
    if (id && !held.nativeConversation) held.nativeConversation = id;
    held.row = row;
  }
  function warmupRecoveryState() {
    const held = warmupRecovery;
    const claim = held?.kind === 'command' ? commandClaim : openingClaim;
    const users = all('user-query').filter(shown), row = users[0];
    const value = users.length === 1 ? compact(authored(row.querySelector('.query-text') || row)) : '';
    if (held?.recovering) retainRecoveredWarmupRow(held, users.length === 1 ? row : null, value);
    else if (held && !held.row && users.length === 1 && value === held.warmup) {
      held.row = row; held.questionId = nativeId(row, 'user');
    }
    const exactWarmup = Boolean(held && users.length === 1 && held.row === row &&
      value === held.warmup && (!held.recovering || Boolean(held.questionKey &&
        warmupQuestionKey(row) === held.questionKey && (!held.nativeConversation || conversationId() === held.nativeConversation))));
    const draft = compact(composerAuthoredText());
    const id = conversationId(), sameRoute = warmupRouteCurrent(held?.route);
    const output = warmupOutput();
    const safeState = Boolean(held && !held.edited && held.current() && claim === held.claim &&
      Date.now() < held.deadline && sameRoute && exactWarmup && composerWritable() &&
      (!draft || draft === held.warmup) && !hasComposerAttachments() && !approvalWaiting() &&
      !all('tool-call,[data-tool-call-id],remy-confirmation-card').some(shown) && (!output || compact(output) === 'READY'));
    return { safe: safeState, kind: held?.kind || null, id: claim?.id || null,
      owner: claim?.client || claim?.owner || null, questionId: exactWarmup ? held.questionId : null,
      deadline: held?.deadline || null, conversationId: id };
  }
  function warmupInitializationState() {
    const held = warmupRecovery, claim = held?.kind === 'command' ? commandClaim : openingClaim;
    const safeState = Boolean(held?.initializing && !held.edited && held.current() && claim === held.claim &&
      claim?.warmupRecovery?.spent === true && !claim.warmupRecovery.initialization &&
      Date.now() < held.deadline && warmupRouteCurrent(held.route) && isAppHomePath(location.pathname) &&
      !conversationId() && composerWritable() && !composerAuthoredText() && !generating() &&
      !hasComposerAttachments() && !approvalWaiting() &&
      !all('user-query,model-response,tool-call,[data-tool-call-id],remy-confirmation-card').some(shown));
    return { safe: safeState, kind: held?.kind || null, id: claim?.id || null,
      owner: claim?.client || claim?.owner || null, deadline: held?.deadline || null };
  }
  // Settle retained preparation, or initialize its proved empty replacement once.
  // Main durably spends that child attempt before its click; the task stays unsent.
  async function resumeWarmupRecovery(stillCurrent = () => true) {
    const claim = commandClaim || openingClaim, projection = claim?.warmupRecovery;
    if (!projection || Date.now() >= projection.expiresAt) return false;
    const route = location.href, kind = commandClaim ? 'command' : 'input';
    const held = { kind, claim, route, warmup: null, deadline: projection.expiresAt, edited: false, initializing: true, recovering: true, current: stillCurrent };
    warmupRecovery = held;
    const refused = reason => {
      // Bounded preparation diagnostics contain no authored text or identifiers.
      try {
        const users = all('user-query').filter(shown), row = users[0];
        console.info('[OneCode warmup recovery] ' + JSON.stringify({ reason, edited: held.edited,
        firstEdit: held.firstEdit || null,
        callerCurrent: safe(stillCurrent, false), claimCurrent: (commandClaim || openingClaim) === claim,
        deadlineCurrent: Date.now() < projection.expiresAt, routeCurrent: warmupRouteCurrent(route),
        editorWritable: composerWritable(), editorEmpty: !composerAuthoredText(), nativeGenerating: generating(),
        userRows: Math.min(3, users.length), rowCurrent: !held.row || row === held.row,
        rowConnected: Boolean(held.row?.isConnected), questionPinned: Boolean(held.questionKey),
        conversationPinned: Boolean(held.nativeConversation),
        conversationCurrent: !held.nativeConversation || conversationId() === held.nativeConversation,
        warmupExact: users.length === 1 && compact(authored(row.querySelector('.query-text') || row)) === held.warmup,
        readyExact: compact(warmupOutput()) === 'READY', filesPresent: hasComposerAttachments(), approvalPresent: approvalWaiting(),
        toolsPresent: all('tool-call,[data-tool-call-id],remy-confirmation-card').some(shown),
        initializationSpent: Boolean(claim.warmupRecovery?.initialization) })); } catch { /* Diagnostics cannot change preparation. */ }
      return false;
    };
    // A refreshed document can claim its spent preparation before Gemini mounts
    // an editable composer or clears the already-submitted tool-free text.
    // Those are settlement conditions, not evidence that this owner changed.
    const hydrationCurrent = () => {
      const draft = compact(composerAuthoredText());
      return !held.edited && stillCurrent() && (commandClaim || openingClaim) === claim &&
        Date.now() < projection.expiresAt && warmupRouteCurrent(route) &&
        (!draft || draft === held.warmup || !held.warmup && [WARMUP, SKILL_WARMUP].includes(draft)) &&
        !hasComposerAttachments() && !approvalWaiting() &&
        !all('tool-call,[data-tool-call-id],remy-confirmation-card').some(shown) && recoveredWarmupConversationCurrent(held);
    };
    const hydrationRowsCurrent = () => {
      const rows = all('user-query').filter(shown);
      const value = rows.length === 1 ? compact(authored(rows[0].querySelector('.query-text') || rows[0])) : '';
      if (rows.length > 1 || (rows.length && ![WARMUP, SKILL_WARMUP].includes(value)) ||
          (held.nativeConversation && conversationId() !== held.nativeConversation) ||
          (rows.length && held.warmup && value !== held.warmup)) return false;
      const key = rows.length ? warmupQuestionKey(rows[0]) : null;
      if (held.questionKey && key && key !== held.questionKey) return false;
      if (rows.length) retainRecoveredWarmupRow(held, rows[0], value);
      // Missing/provisional rows and streaming presentation are observations,
      // never settlement. The final proof below still needs the same positive
      // question, exact READY, native idle and empty editor within this deadline.
      return true;
    };
    let performingInitializationEdit = false;
    const noteEdit = event => {
      if (event.isTrusted && !performingInitializationEdit) {
        if (!held.edited) held.firstEdit = { beforeInput: event.type === 'beforeinput',
          inComposer: Boolean(event.target?.closest?.(BOX)), empty: !composerAuthoredText() };
        held.edited = true;
      }
    };
    document.addEventListener('beforeinput', noteEdit, true); document.addEventListener('input', noteEdit, true);
    try {
      let emptySince = null;
      const preparation = await waitFor(() => {
        if (all('user-query').some(shown)) return 'retained';
        if (warmupInitializationResolver && warmupInitializationState().safe) {
          if (emptySince === null) emptySince = Date.now();
          if (Date.now() - emptySince >= 500) return 'initialize';
        } else emptySince = null;
        return null;
      }, () => hydrationCurrent() && hydrationRowsCurrent(), Math.max(0, projection.expiresAt - Date.now()));
      if (!preparation) return refused('preparation-ended');
      if (preparation === 'initialize') {
        const proof = warmupInitializationState();
        let permit = null;
        try { permit = await warmupInitializationResolver({ kind, id: proof.id, owner: proof.owner, deadline: held.deadline }); }
        catch { return refused('initialization-permit-unavailable'); }
        const granted = permit?.warmupRecovery;
        if (!permit?.ok || permit.allowed !== true || granted?.spent !== true ||
            granted.at !== projection.at || granted.expiresAt !== projection.expiresAt ||
            (granted.questionId ?? null) !== (projection.questionId ?? null) ||
            !Number.isFinite(granted.initialization?.at) || !warmupInitializationState().safe) return refused('initialization-permit-refused');
        held.initializing = false;
        claim.warmupRecovery = recoveryProjection(granted);
        const emptyCurrent = () => hydrationCurrent() && !conversationId() && isAppHomePath(location.pathname) &&
          !all('user-query,model-response').some(shown) && !generating();
        held.warmup = WARMUP;
        const initializerBox = composer();
        if (!emptyCurrent() || !initializerBox) return refused('initialization-source-changed');
        initializerBox.focus({ preventScroll: true });
        const initialized = await sendControlledWarmup(initializerBox, '', WARMUP, emptyCurrent,
          reason => console.info('[OneCode warmup initialization] ' + reason),
          replacement => emptyCurrent() && replacement === composer() && replacement?.isConnected,
          operation => {
            // execCommand emits trusted input for our synchronous insertion.
            // Human edits during every asynchronous wait still revoke custody.
            performingInitializationEdit = true;
            try { return operation(); } finally { performingInitializationEdit = false; }
          });
        // A dispatched preparation cannot be repeated on an unknown outcome.
        // Its native row and real route still have to pass the normal proof below.
        if (initialized !== WARMUP) return refused('initialization-send-unconfirmed');
      }
      held.initializing = false;
      const settled = await waitFor(() => {
        const warm = all('user-query').filter(shown);
        const value = warm.length === 1 ? compact(authored(warm[0].querySelector('.query-text') || warm[0])) : '';
        if (!held.warmup && [WARMUP, SKILL_WARMUP].includes(value)) held.warmup = value;
        const proof = warmupRecoveryState();
        return proof.safe && proof.conversationId && !composerAuthoredText() && !generating() &&
          compact(warmupOutput()) === 'READY' && proof.conversationId;
      }, () => hydrationCurrent() && hydrationRowsCurrent(),
        Math.max(0, projection.expiresAt - Date.now()));
      if (!settled || !warmupRecoveryState().safe) return refused('settlement-unconfirmed');
      preparedOpening = settled; return true;
    } finally {
      document.removeEventListener('beforeinput', noteEdit, true); document.removeEventListener('input', noteEdit, true);
      if (warmupRecovery === held) warmupRecovery = null;
    }
  }
  async function settleControlledWarmup(warmup, current, deadline = Date.now() + 180000) {
    let changedAt = Date.now(), previous = null, edited = false;
    const noteEdit = event => { if (event.isTrusted) edited = true; };
    // The accepted warm-up row can mount before Gemini clears its editor. Keep
    // custody of that exact tool-free text while native cleanup catches up; an
    // empty editor is still required before restoring or authorizing the task.
    const owns = () => !edited && current() && (!composerAuthoredText() || compact(composerAuthoredText()) === compact(warmup)) && !hasComposerAttachments() &&
      compact(authored(all('user-query').at(-1)?.querySelector('.query-text') || all('user-query').at(-1))) === warmup;
    document.addEventListener('beforeinput', noteEdit, true);
    document.addEventListener('input', noteEdit, true);
    try {
      const outcome = await waitFor(() => {
        const output = all('model-response').filter(shown).map(text).join('\n');
        if (!composerAuthoredText() && !generating() && output.trim() && composerWritable()) return 'settled';
        if (output !== previous) { previous = output; changedAt = Date.now(); }
        return Date.now() - changedAt >= 45000 ? 'stalled' : null;
      }, owns, Math.max(0, deadline - Date.now()));
      if (!owns()) return false;
      if (outcome === 'settled') return true;
      // The only submitted input is our exact tool-free warm-up. Stop it once,
      // then wait for native idle before restoring the still-unsent real task.
      // No task Send is retried, and a refreshed document cannot inherit this closure.
      if (!generating() || !stopGeneration(owns)) return false;
      console.info('[OneCode warmup] stopped stalled tool-free preparation');
      return Boolean(await waitFor(() => !composerAuthoredText() && !generating() && composerWritable(), owns, Math.max(0, Math.min(30000, deadline - Date.now())))) && owns();
    } finally {
      document.removeEventListener('beforeinput', noteEdit, true);
      document.removeEventListener('input', noteEdit, true);
    }
  }
  /** One native Send, then exact new user-row evidence. Never resend after an ambiguous click. */
  async function send({ acceptanceTimeoutMs = 30000, stillCurrent = () => true, matchesUser = null, clearAcceptedDraft = true,
    beforeSend = null, acceptUserReceipt = null, receiptTimeoutMs = null, mention = null, explain = null, whileGenerating = false, initialDraft = null,
    prepareAttachments = null, nativeMedia = false, onSendAttempt = null, requestedModel = null, requestedEffort = null } = {}) {
    const refused = reason => {
      console.info('[OneCode Send] ' + JSON.stringify({ reason, callerCurrent: stillCurrent(),
        conversationPresent: Boolean(conversationId()), preparedConversation: Boolean(preparedConversation()),
        commandPresent: Boolean(commandClaim), editorWritable: composerWritable(), nativeGenerating: generating() }));
      explain?.(reason); return false;
    };
    let box = composer(), id = conversationId();
    const submitted = composerAuthoredText();
    if (!box || !submitted || !composerWritable()) return refused('editor-not-ready');
    if ((commandClaim || openingClaim)?.warmupRecovery && (!id || preparedConversation() !== id))
      return refused('warmup-recovery-not-settled');
    // An explicit, receipt-owned message may use Gemini's native Send while
    // its previous response runs. The caller retains its exact source question
    // and input claim; neither Stop nor a cleared editor proves acceptance.
    if (whileGenerating ? !id || typeof acceptUserReceipt !== 'function' : generating()) return refused('page-busy');
    const current = () => stillCurrent() && composer() === box && (!id || conversationId() === id);
    const prior = new Set(messages().filter(message => message.role === 'user').map(message => message.id));
    const initialRoute = location.href, initialCommand = commandClaim, initialOpening = openingClaim, initialAttachments = attachmentRows();
    let initialEditRevoked = false, rebound = false, nativeStopAttempted = false, nativeStopFailed = false;
    const noteInitialEdit = event => {
      if (event.isTrusted && event.target?.closest?.(BOX)) initialEditRevoked = true;
    };
    const initialCurrent = () => {
      if (initialEditRevoked || nativeStopFailed || !stillCurrent() || location.href !== initialRoute) return false;
      const attachments = attachmentRows();
      if (attachments.length !== initialAttachments.length || attachments.some((node, index) => node !== initialAttachments[index])) return false;
      const editor = composer();
      if (editor === box) return true;
      // Gemini can replace the fresh worker's editing host after accepting the
      // full insertion. Follow that one native remount only through the existing
      // command and draft lease, before either warm-up or task Send can occur.
      if (rebound || !initialDraft || !initialCommand || commandClaim !== initialCommand || box.isConnected ||
          !editor?.isConnected || !composerWritable() || compact(composerAuthoredText()) !== compact(submitted)) return false;
      if (!initialDraft.rebind() || !initialDraft.current()) return false;
      box = editor; rebound = true;
      return true;
    };
    document.addEventListener('beforeinput', noteInitialEdit, true); document.addEventListener('input', noteInitialEdit, true);
    let ready;
    try {
      ready = await waitFor(() => {
        const candidate = sendButton();
        if (enabled(candidate)) return candidate;
        // Some Gemini layouts keep Stop in place even with a fully typed
        // steering draft. This exact claimed input may use that native control
        // once; it never asks Main to kill a process, close or reload the page.
        // Send readiness shares this original deadline, and acceptance still
        // requires the exact new user row below.
        const stop = stopButton();
        if (whileGenerating && !nativeStopAttempted && enabled(stop) && initialCurrent() &&
            compact(composerAuthoredText()) === compact(submitted) && (!initialDraft || initialDraft.current())) {
          nativeStopAttempted = true;
          try { stop.click(); }
          catch { nativeStopFailed = true; }
        }
        return null;
      }, initialCurrent, Math.min(30000, acceptanceTimeoutMs));
    } finally {
      document.removeEventListener('beforeinput', noteInitialEdit, true); document.removeEventListener('input', noteInitialEdit, true);
    }
    if (!ready || !initialCurrent() || !current() || compact(composerAuthoredText()) !== compact(submitted)) {
      const editor = composer(), authoredText = composerAuthoredText();
      console.info('[OneCode initial Send] ' + JSON.stringify({
        callerCurrent: stillCurrent(), editorSame: editor === box, editorConnected: box.isConnected,
        routeMatches: conversationId() === id, initialConversationPresent: Boolean(id), currentConversationPresent: Boolean(conversationId()),
        expectedLength: submitted.length, authoredLength: authoredText.length, authoredMatches: compact(authoredText) === compact(submitted),
        readyObserved: Boolean(ready), sendPresent: Boolean(sendButton()), sendEnabled: enabled(sendButton()),
        editorWritable: composerWritable(), nativeGenerating: generating(), commandPresent: Boolean(commandClaim), openingPresent: Boolean(openingClaim),
        initialEditRevoked, initialEditorRebound: rebound
      }));
      return refused(nativeStopFailed ? 'native-stop-unconfirmed' : 'send-not-ready');
    }
    if (!id && !localHelper) {
      // Warm-up must contain only its controlled text. Native files belong to
      // the later real task and are prepared only after its actual chat exists.
      if (hasComposerAttachments()) return refused('warmup-attachments-present');
      // Gemini assigns a chat ID only after a real first Send. Keep tools out of this
      // controlled warm-up; a guessed/provisional ID never authorizes local execution.
      const warmup = await sendControlledWarmup(box, submitted, openingWarmup(submitted), current, explain, replacement => {
        if (!stillCurrent() || id || conversationId() || location.href !== initialRoute) return false;
        box = replacement; return current();
      });
      if (!warmup) return false;
      const claim = initialCommand || initialOpening;
      const deadline = Date.now() + 180000, refreshAfter = Date.now() + 15000;
      const held = { kind: initialCommand ? 'command' : 'input', claim, route: initialRoute, warmup,
        deadline, edited: false, current: stillCurrent };
      warmupRecovery = held;
      const noteWarmupEdit = event => { if (event.isTrusted) held.edited = true; };
      document.addEventListener('beforeinput', noteWarmupEdit, true); document.addEventListener('input', noteWarmupEdit, true);
      let refreshRequested = false, refreshResult = null;
      const refreshTimer = setInterval(() => {
        const proof = warmupRecoveryState();
        if (Date.now() < refreshAfter || !claim || !warmupRecoveryResolver || !proof.safe || proof.conversationId || refreshRequested) return;
        refreshRequested = true;
        Promise.resolve(warmupRecoveryResolver({ kind: proof.kind, id: proof.id, owner: proof.owner,
          questionId: proof.questionId, deadline })).then(result => {
          refreshResult = result;
          if (result?.ok === true && result.dispatched === true) warmupRefreshPending = true;
        }).catch(() => { refreshResult = { ok: false }; });
      }, 200);
      let warmId;
      try {
        warmId = await waitFor(() => {
          if (warmupRefreshPending) return 'refresh-dispatched';
          // A permit racing READY has spent preparation custody. Await the exact
          // original-document adoption before continuing to the real task.
          if (refreshRequested && !refreshResult) return null;
          if (refreshRequested && refreshResult?.spent && refreshResult?.recovered !== true) return 'refresh-refused';
          return conversationId() && all('user-query').some(node =>
            compact(authored(node.querySelector('.query-text') || node)) === warmup) && conversationId();
        }, () => !held.edited && stillCurrent(), Math.max(0, deadline - Date.now()));
      } finally {
        clearInterval(refreshTimer);
        document.removeEventListener('beforeinput', noteWarmupEdit, true); document.removeEventListener('input', noteWarmupEdit, true);
        if (warmupRecovery === held) warmupRecovery = null;
      }
      if (warmId === 'refresh-dispatched') return false;
      if (!warmId || warmId === 'refresh-refused') return refused('warmup-acceptance-unconfirmed');
      id = warmId;
      preparedOpening = warmId;
      const settled = await settleControlledWarmup(warmup, () => stillCurrent() && conversationId() === id &&
        (initialCommand ? commandClaim === initialCommand : openingClaim === initialOpening), deadline);
      if (!settled || composerAuthoredText()) return refused('warmup-not-settled');
      box = composer();
      if (!insertPrompt(submitted, true)) return refused('task-not-restored');
      // The accepted warm-up can mount a new native editing host. Transfer the
      // existing task lease only at this controlled empty -> exact-task boundary,
      // under the same command and the conversation proved by its warm-up row.
      // Otherwise the shared bootstrap guard still sees the disconnected host
      // and refuses the real task before Send.
      if (initialDraft && initialCommand && commandClaim === initialCommand &&
          !initialDraft.current() && (!current() || !initialDraft.rebind() || !initialDraft.current()))
        return refused('task-lease-not-restored');
      // Fresh native conversation creation can reset the account's selected mode.
      // Re-prove/reselect the requested model on that exact successor before Core
      // selection, attachments or final Send authorization. Never resend warm-up.
      if ((requestedModel && requestedModel !== 'gemini-current' || requestedEffort) &&
          !await selectModelSettings(requestedModel, requestedEffort, current, explain))
        return refused('post-warmup-model-unconfirmed');
    }
    const binding = id && !localHelper ? await bindingFor(id, current) : null;
    if (id && !localHelper && !binding) return refused('session-binding-unavailable');
    // Native image generation cannot run with an app selected. Still resolve the
    // exact opening/input binding above; transport identity and Send admission
    // remain unchanged, but this message exposes no local connector or key.
    const connector = localHelper || nativeMedia ? null : binding?.connector_name || mention?.name || ownNames[0];
    let connectorRefusal = null;
    if (connector && !await selectConnector(connector, current, reason => { connectorRefusal = reason; }))
      return refused(connectorRefusal || 'connector-not-selected');
    // Native files keep Send enabled even after the editor is cleared. Select
    // the real Core token while its required empty-composer boundary is still
    // available, then stage files once for the restored task before admission.
    if (prepareAttachments && (!current() || await prepareAttachments(current) !== true || !current() ||
        compact(composerAuthoredText()) !== compact(submitted))) return refused('attachment-upload-unconfirmed');
    if (connector && !confirmedMention(connector, box)) return refused('connector-token-unconfirmed');
    if (binding && !nativeMedia && !appendSessionFrame(box, binding)) return refused('session-context-not-inserted');
    const draftReady = stage => {
      const callerCurrent = current(), editor = composer(), authoredText = composerAuthoredText(), raw = blockText(editor);
      const authoredMatches = compact(authoredText) === compact(submitted), sendEnabled = enabled(sendButton());
      const attachmentsCurrent = !prepareAttachments || !initialDraft || initialDraft.current();
      if (callerCurrent && authoredMatches && sendEnabled && attachmentsCurrent) return true;
      console.info('[OneCode draft] ' + JSON.stringify({ stage, callerCurrent, editorSame: editor === box, editorConnected: box.isConnected,
        routeMatches: conversationId() === id, expectedLength: submitted.length, authoredLength: authoredText.length, authoredMatches,
        visibleLength: raw.length, sendPresent: Boolean(sendButton()), sendEnabled, mentionRequired: Boolean(connector),
        mentionConfirmed: Boolean(connector && confirmedMention(connector, editor)), nativeMentionProof: Boolean(connector && provenMention(editor)?.name === connector),
        controlFramePresent: raw.includes('[[GEMINI_LOCAL_SESSION]]'), controlFrameComplete: CONTROL.test(raw),
        bindingPresent: Boolean(binding), bindingConversationMatches: binding?.conversation_id === id, attachmentsCurrent }));
      return false;
    };
    const waitDraftReady = async stage => {
      // Core/catalog changes can temporarily remove Send after the exact task
      // and control frame are already stable. Readiness may settle; authored
      // text, editor, route and caller ownership may not change while waiting.
      const exactCurrent = () => current() && compact(composerAuthoredText()) === compact(submitted) &&
        (!prepareAttachments || !initialDraft || initialDraft.current());
      await waitFor(() => enabled(sendButton()) && sendButton(), exactCurrent, 30000);
      return draftReady(stage);
    };
    if (!await waitDraftReady('before-authorization')) return refused('draft-changed');
    if (beforeSend && await beforeSend(current) !== true) return refused('not-authorized');
    if (!await waitDraftReady('after-authorization')) return refused('draft-changed');
    const button = sendButton();
    if (!current() || !enabled(button) || button !== sendButton() || !draftReady('before-click')) return refused('send-not-ready');
    if (connector && provenMention(box)) outgoingMention = { name: provenMention(box).name, expected: submitted, conversationId: id, priorIds: prior };
    cancelApprovalReplyProofs('new-send'); onSendAttempt?.(); button.click();
    const accepted = await waitFor(() => {
      const now = conversationId();
      if (id && now !== id) return null;
      for (const message of messages().filter(message => message.role === 'user').reverse()) {
        if (prior.has(message.id) || (matchesUser ? !matchesUser(message, submitted) : compact(message.text) !== compact(submitted))) continue;
        if (acceptUserReceipt && !acceptUserReceipt(message, now)) continue;
        return message;
      }
      return null;
    }, () => stillCurrent() && (!id || conversationId() === id), receiptTimeoutMs || 180000);
    if (!accepted) return refused('send-acceptance-unconfirmed');
    outgoingMention = null;
    if (clearAcceptedDraft && current()) clearPromptExact(submitted);
    return true;
  }
  function approvalCards() {
    return safe(() => {
      const candidates = all('remy-confirmation-card button').filter(node => shown(node) && /^(?:Allow|Allow once)$/i.test(text(node)));
      const cards = [];
      for (const allow of candidates) {
        const card = allow.closest('remy-confirmation-card');
        const header = card?.querySelector('[data-test-id="header"]');
        const connector = compact(text(header));
        if (!header || !connector || connector.length > 160) continue;
        // Native header contains only the connector name. Its permission
        // sentence is a separate direct paragraph in the body; both must agree.
        const titles = all('[data-test-id="body"] > p', card).map(node => compact(text(node)))
          .filter(value => value.length <= 500).map(value => /^Let Gemini use [“"](.+?)[”"] from (.+?)\s*$/i.exec(value)).filter(Boolean);
        const title = titles.length === 1 && titles[0][2] === connector ? titles[0] : null;
        const deny = all('button', card).filter(node => shown(node) && /^Deny$/i.test(text(node)));
        if (!title || deny.length !== 1 || all('button', card).filter(node => shown(node) && /^(?:Allow|Allow once)$/i.test(text(node))).length !== 1) continue;
        // Historical completed cards remain mounted, often with a working Expand
        // text button. Only an enabled decision can keep this conversation waiting.
        if (!enabled(allow) && !enabled(deny[0])) continue;
        const detail = all('[data-test-id="body"],[data-test-id="collapsed-details"]', card).map(text).join('\n');
        // A native display title such as "write stdin" is not the machine tool
        // "write". Only a complete single-token detail can override the exact
        // permission title; otherwise policy checks that whole title below.
        const machine = /(?:^|\n)[ \t]*Tool:[ \t]*([a-z][a-z0-9_]{0,79})[ \t]*(?=\r?\n|$)/.exec(detail)?.[1] || null;
        cards.push({ node: card, lines: [title[0]], allow: enabled(allow), tool: title[1], machineTool: machine,
          connector: title[2], allowButton: allow, denyButton: deny[0] });
      }
      const uniqueCards = cards.filter((card, at) => cards.findIndex(other => other.node === card.node) === at);
      return uniqueCards;
    }, []);
  }
  const approvalCard = () => { const cards = approvalCards(); return cards.length === 1 ? cards[0] : null; };
  const approvalClicks = new WeakSet();
  // Native decisions clicked by the user need the same exact exchange receipt
  // as Companion clicks. Otherwise Gemini's generated Allow row is mistaken
  // for a new authored task and cancels the handoff it was approving.
  document.addEventListener('click', function noteNativeApprovalDecision(event) {
    if (!event.isTrusted) return;
    const button = event.target?.closest?.('button');
    const card = approvalCards().find(card => card.allowButton === button || card.denyButton === button);
    if (!card || !enabled(button) || approvalClicks.has(card.node)) return;
    approvalClicks.add(card.node);
    expectApprovalReply(card, card.allowButton === button ? 'allow' : 'deny');
  }, true);
  function clickApprovalCard(expected, choice) {
    const card = approvalCards().find(card => card.node === expected.node);
    if (!card || card.tool !== expected.tool || card.machineTool !== expected.machineTool || card.connector !== expected.connector) return 'card_changed';
    const node = card.node;
    const button = choice === 'allow' ? card.allowButton : choice === 'deny' ? card.denyButton : null;
    if (!enabled(button) || approvalClicks.has(node)) return 'unavailable';
    approvalClicks.add(node); expectApprovalReply(card, choice); button.click(); return 'clicked';
  }
  function answerApprovalCard(node, choice) {
    const card = approvalCard();
    return card?.node === node ? clickApprovalCard(card, choice) : 'card_changed';
  }
  let approvalFlight = null;
  const approvalObservations = [];
  const approvalMismatchNotes = new WeakMap();
  let approvalMismatch = null;
  const approvalIssue = () => {
    const issue = approvalMismatch;
    if (!issue || conversationId() !== issue.conversationId ||
        !approvalCards().some(card => card.node === issue.node && card.connector === issue.connector && card.allow && !approvalClicks.has(card.node))) return null;
    return { reason: 'connector-mismatch', connector: issue.connector, expectedConnector: issue.expectedConnector };
  };
  async function maybeAutoApprove() {
    if (localHelper) return false;
    if (!approvalReceiptsReady()) return false;
    if (approvalFlight) return approvalFlight;
    const cards = approvalCards(), id = conversationId();
    if (!id || !cards.some(card => card.allow && !approvalClicks.has(card.node))) return false;
    approvalFlight = (async () => {
      let clicked = false;
      for (const card of cards) {
      if (!card.allow || approvalClicks.has(card.node) || !card.node.isConnected || conversationId() !== id) continue;
      const binding = await bindingFor(id, () => conversationId() === id && card.node.isConnected);
      const ownedNames = Array.isArray(binding?.connector_names) ? binding.connector_names : [binding?.connector_name];
      const matches = ownedNames.filter(name => name === card.connector);
      const configuredName = matches.length === 1 ? matches[0] : null;
      if (binding?.auto_approve === true && !configuredName && typeof binding.connector_name === 'string') {
        if (approvalMismatchNotes.get(card.node) !== binding.connector_name) {
          approvalObservations.push({ at: Date.now(), conversationId: id, tool: card.tool, outcome: 'connector-mismatch', connector: card.connector, expectedConnector: binding.connector_name });
          if (approvalObservations.length > 50) approvalObservations.shift();
          approvalMismatchNotes.set(card.node, binding.connector_name);
        }
        approvalMismatch = { node: card.node, conversationId: id, connector: card.connector, expectedConnector: binding.connector_name };
      } else if (approvalMismatch?.node === card.node) approvalMismatch = null;
      const perConnector = binding?.enabled_tools_by_connector;
      const enabledTools = configuredName && perConnector && Object.prototype.hasOwnProperty.call(perConnector, configuredName) ? perConnector[configuredName] :
        configuredName === binding?.connector_name ? binding?.enabled_tools : null;
      if (!binding || binding.auto_approve !== true || !configuredName ||
        !Array.isArray(enabledTools) || !enabledTools.includes(card.machineTool || card.tool)) continue;
      const outcome = clickApprovalCard(card, 'allow');
      approvalObservations.push({ at: Date.now(), conversationId: id, tool: card.tool, outcome });
      if (approvalObservations.length > 50) approvalObservations.shift();
      if (outcome === 'clicked') clicked = true;
      }
      return clicked;
    })().finally(() => { approvalFlight = null; });
    return approvalFlight;
  }
  const pendingApprovalIn = root => all('remy-confirmation-card button', root).some(button =>
    enabled(button) && /^(?:Allow|Allow once|Deny)$/i.test(text(button)));
  const approvalWaiting = () => pendingApprovalIn(document);
  const messageComplete = message => Boolean(message?.node?.querySelector('.response-footer.complete')) &&
    !pendingApprovalIn(message.node) && !generating();
  function completedResponseReceipt(allowStaleStop = false) {
    if (!approvalReceiptsReady()) return null;
    const rows = messages(), question = rows.findLast(row => row.role === 'user'), answer = rows.at(-1);
    if (!question || answer?.role !== 'assistant' || !answer.node.isConnected ||
        !new RegExp(`^gemini:${conversationId()}:assistant:[0-9a-f]{16}$`).test(answer.id) ||
        !answer.node.querySelector('.response-footer.complete') || approvalWaiting() ||
        all('model-response [aria-busy="true"]').some(shown) || (!allowStaleStop && generating()) ||
        errors().some(error => error.blocking)) return null;
    return { provider: 'gemini', conversationId: conversationId(), questionId: question.id, messageId: answer.id, text: answer.text };
  }
  function recoveryTerminalReceipt(questionId) {
    const receipt = completedResponseReceipt();
    // The exact response's native complete footer is terminal evidence. Stop
    // disappearance by itself cannot manufacture this receipt.
    return receipt && receipt.questionId === questionId ? { ...receipt, outcome: 'complete' } : null;
  }
  const generating = () => stopButton() !== null || approvalWaiting() || all('model-response [aria-busy="true"]').some(shown);
  const stopGeneration = current => { const stop = stopButton(); if (!current() || !enabled(stop)) return false; stop.click(); return true; };
  const attachmentRows = () => composerBox() ? all('uploader-file-preview', composerBox()).filter(shown) : [];
  function attachmentName(row) {
    const containers = all('.file-preview-container[aria-describedby]', row);
    if (containers.length !== 1) return null;
    const names = containers[0].getAttribute('aria-describedby').split(/\s+/).filter(Boolean).map(id => document.getElementById(id))
      .filter(node => node?.getAttribute('role') === 'tooltip' && !node.closest(OWN))
      .map(node => node.textContent || '').filter(value => value.trim() && value.length <= 512);
    // The native image close button is generic and document labels omit their
    // extension. Only the preview's native accessibility description names it.
    return names.length === 1 ? names[0] : null;
  }
  const composerAttachmentNames = () => attachmentRows().map(attachmentName).filter(name => name !== null).sort();
  const hasComposerAttachments = () => attachmentRows().length > 0;
  const attachmentComplete = row => {
    const close = all('.gem-attachment-close-button button[aria-label]', row);
    // Native completed close controls are CSS-hidden until hover.
    return close.length === 1 && close[0].isConnected && !close[0].disabled && close[0].getAttribute('aria-disabled') !== 'true' &&
      !close[0].closest('[inert],[hidden],[aria-hidden="true"]') && /^close /i.test(close[0].getAttribute('aria-label') || '');
  };
  // The native Files component owns its direct hidden input. Descendant
  // selector-service inputs and the surrounding uploader are separate owners.
  const nativeFileInputs = owner => all(':scope > input.hidden-file-input[type="file"]', owner).filter(node => !node.disabled && node.multiple);
  async function uploadImages(images = [], current = () => true, draft = null, extraFiles = []) {
    // Gemini's CSV document loader rejects ordinary text/csv on this account.
    // A text view keeps every original byte; only the native upload name/type
    // changes. Desktop attachment metadata and history retain the original.
    const reservedNames = new Set(extraFiles.map(file => file.name.toLowerCase()));
    const files = extraFiles.map(file => {
      if (!/\.csv$/i.test(file.name)) return file;
      let name = file.name + '.txt', suffix = 2;
      while (reservedNames.has(name.toLowerCase())) name = `${file.name} (${suffix++}).txt`;
      reservedNames.add(name.toLowerCase());
      return new File([file], name, { type: 'text/plain', lastModified: file.lastModified });
    });
    const box = composer(), host = composerBox(), route = location.href;
    let revoked = false, performing = false, dispatchAttempted = false;
    const refuse = stage => {
      const owners = all('images-files-uploader[data-test-id="uploader-images-files-button-advanced"]').filter(node => shown(node) &&
        node.closest('mat-action-list[role="menu"][aria-label="Menu options"]'));
      const inputs = owners.flatMap(owner => all('input[type="file"]', owner)).filter(node => !node.disabled && node.multiple);
      const rows = attachmentRows(), unmatched = rows.map(attachmentName);
      const namesMatched = files.reduce((count, file) => { const index = unmatched.indexOf(file.name); if (index < 0) return count; unmatched.splice(index, 1); return count + 1; }, 0);
      console.info('[OneCode upload] ' + JSON.stringify({ stage, requested: files.length, ownerCount: owners.length, inputCount: inputs.length,
        primaryInputCount: owners.flatMap(nativeFileInputs).length,
        previewCount: rows.length, namesMatched, completedPreviews: rows.filter(attachmentComplete).length,
        dispatchAttempted, callerCurrent: current(), draftCurrent: Boolean(draft?.current()),
        editorSame: composer() === box, hostSame: composerBox() === host, routeMatches: location.href === route, trustedEditRevoked: revoked,
        progressCount: host ? all('[aria-busy="true"],[role="progressbar"]', host).filter(shown).length : 0,
        alertCount: all('[role="alert"]').filter(shown).length, sendPresent: Boolean(sendButton()), sendEnabled: enabled(sendButton()) }));
      return false;
    };
    for (const image of images || []) {
      const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-zA-Z0-9+/=]+)$/.exec(image.dataUrl || '');
      if (!match) return refuse('image-format-invalid');
      files.push(new File([Uint8Array.from(atob(match[2]), value => value.charCodeAt(0))], image.name || 'image.png', { type: match[1] }));
    }
    if (!files.length) return true;
    if (!host || !box || files.length > 20 || !current() || !draft?.current() || hasComposerAttachments()) return refuse('entry-not-owned');
    if (files.some(file => file.name.length > 512)) return refuse('filename-unconfirmed');
    const trigger = unique(all('button[aria-label="Upload and tools"]', host));
    if (!enabled(trigger)) return refuse('trigger-unavailable');
    const own = action => { performing = true; try { return action(); } finally { performing = false; } };
    const interrupt = event => {
      if (!performing && event.isTrusted && (host.contains(event.target) || event.target?.matches?.('input[type="file"]'))) revoked = true;
    };
    const onTarget = () => !revoked && current() && draft.current() && location.href === route && composer() === box && composerBox() === host;
    const wasOpen = trigger.getAttribute('aria-expanded') === 'true';
    const priorAlerts = new Set(all('[role="alert"]').filter(shown));
    for (const type of ['beforeinput', 'input', 'change']) document.addEventListener(type, interrupt, true);
    try {
      if (!wasOpen) own(() => trigger.click());
      const input = await waitFor(() => {
        const owners = all('images-files-uploader[data-test-id="uploader-images-files-button-advanced"]').filter(node => shown(node) &&
          node.closest('mat-action-list[role="menu"][aria-label="Menu options"]'));
        if (owners.length !== 1 || trigger.getAttribute('aria-expanded') !== 'true') return null;
        const choices = nativeFileInputs(owners[0]);
        return choices.length === 1 ? choices[0] : null;
      }, onTarget);
      if (!input || !onTarget() || hasComposerAttachments()) return refuse('input-unconfirmed');
      try {
        const transfer = new DataTransfer(); for (const file of files) transfer.items.add(file);
        own(() => { dispatchAttempted = true; input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true })); });
      } catch { return refuse('assignment-failed'); }
      const result = await waitFor(() => {
        if (all('[role="alert"]').some(node => shown(node) && !priorAlerts.has(node))) return { ok: false, reason: 'new-alert' };
        const rows = attachmentRows();
        if (rows.length > files.length) return { ok: false, reason: 'extra-preview' };
        if (rows.length !== files.length) return null;
        const names = rows.map(attachmentName), unmatched = [...names];
        if (!files.every(file => { const index = unmatched.indexOf(file.name); if (index < 0) return false; unmatched.splice(index, 1); return true; })) return null;
        if (all('[aria-busy="true"],[role="progressbar"]', host).some(shown) || !enabled(sendButton())) return null;
        if (!rows.every(attachmentComplete)) return null;
        return { ok: true, rows };
      }, onTarget, extraFiles.length ? 600000 : 60000);
      if (!result?.ok || !onTarget()) return refuse(result?.reason || (onTarget() ? 'completion-unconfirmed' : 'lease-withdrawn'));
      draft.attachments(result.rows);
      return draft.current() || refuse('completed-draft-changed');
    } finally {
      if (!wasOpen && onTarget() && trigger.isConnected && trigger.getAttribute('aria-expanded') === 'true') own(() => trigger.click());
      for (const type of ['beforeinput', 'input', 'change']) document.removeEventListener(type, interrupt, true);
    }
  }
  const pickerButton = () => unique(all('button[aria-label^="Open mode picker"]'));
  const modelPickerCaption = picker => {
    if (!picker) return '';
    const caption = compact(text(picker).replace(/arrow_drop_down|expand_more|keyboard_arrow_down/g, ''));
    const accessible = /^Open mode picker, currently ([^\r\n]{1,96})$/.exec(picker.getAttribute('aria-label') || '')?.[1];
    return caption || compact(accessible || '');
  };
  const modelPickerLaneCurrent = (picker, label) => {
    const lane = value => compact(value).normalize('NFKC').replace(/^Gemini\s*/i, '').replace(/^\d+(?:\.\d+)*\s*/, '')
      .toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    const actual = lane(modelPickerCaption(picker)), wanted = lane(label);
    // The caption cannot identify a versioned ID, but a positive lane mismatch
    // (for example Flash after selecting Argon) must not be reported as success.
    return !actual || !wanted || actual === wanted;
  };
  const visibleModelSelection = () => {
    const picker = pickerButton();
    if (!picker) return null;
    const caption = compact(text(picker).replace(/arrow_drop_down|expand_more|keyboard_arrow_down/g, ''));
    // The native compact header may keep only its arrow inside the button;
    // its accessible label still states the selected model explicitly.
    const accessible = /^Open mode picker, currently ([^\r\n]{1,96})$/.exec(picker.getAttribute('aria-label') || '')?.[1];
    if (!caption && !compact(accessible || '')) return null;
    // The collapsed caption names a lane (for example "Gemini Flash"), not a
    // versioned mode ID. Report the existing current-model option rather than
    // inventing an exact catalog match for worker/session observations.
    const selected = nativeModelMenu()?.find(row => row.selected);
    const selectedEffort = nativeThinkingMenu(nativeThinkingTrigger())?.find(row => row.selected)?.id;
    return { model: selected?.id || 'gemini-current', reasoningEffort: selectedEffort || null };
  };
  const nativeModelRows = () => all('gem-menu-item[role="menuitem"][data-mode-id]').filter(node => shown(node) && !node.closest(TURN));
  const nativeModelSelected = node => {
    const explicit = ['aria-checked', 'aria-selected'].map(name => node.getAttribute(name)).filter(value => value !== null);
    return explicit.length ? explicit.every(value => value === 'true') :
      node.classList.contains('selected') && Boolean(node.querySelector('[aria-label="Selected"]'));
  };
  function nativeModelMenu() {
    const rows = nativeModelRows().filter(node => enabled(node) && /^[0-9a-f]{16}$/i.test(node.getAttribute('data-mode-id') || '') &&
      !node.querySelector('[data-mat-icon-name="lock"],[fonticon="lock"],[data-mat-icon-name="lock_outline"],[fonticon="lock_outline"]') &&
      !all('mat-icon,gem-icon', node).some(icon => /^(?:lock|lock_outline)$/.test(compact(text(icon))))).map(node => ({ node,
        id: node.getAttribute('data-mode-id').toLowerCase(), label: compact(text(node.querySelector('.label'))),
        selected: nativeModelSelected(node) }));
    if (!rows.length || rows.some(row => !row.label || row.label.length > 80) || new Set(rows.map(row => row.id)).size !== rows.length ||
        rows.filter(row => row.selected).length !== 1) return null;
    return rows;
  }
  function nativeThinkingTrigger() {
    const roots = [...new Set(nativeModelRows().map(node => node.closest('gem-menu[role="menu"]')).filter(Boolean))];
    if (roots.length !== 1) return null;
    return unique(all('gem-menu-item[role="menuitem"][aria-haspopup="true"][aria-controls]', roots[0]).filter(node =>
      shown(node) && enabled(node) && node.closest('gem-menu[role="menu"]') === roots[0] &&
      !node.hasAttribute('data-mode-id') && compact(text(node.querySelector('.label'))) === 'Thinking level'));
  }
  function nativeThinkingMenu(trigger) {
    if (!trigger?.isConnected || trigger.getAttribute('aria-expanded') !== 'true') return null;
    const menu = document.getElementById(trigger.getAttribute('aria-controls'));
    if (!menu?.matches('gem-menu[role="menu"]') || !shown(menu) || menu.getAttribute('data-visible') === 'false') return null;
    const rows = all('gem-menu-item[role="menuitem"]', menu).filter(node => shown(node) && enabled(node) &&
      node.closest('gem-menu[role="menu"]') === menu && !node.hasAttribute('data-mode-id')).map(node => ({
        node, id: compact(text(node.querySelector('.label'))).toLowerCase(), selected: nativeModelSelected(node)
      }));
    if (!rows.length || rows.some(row => !['low', 'medium', 'high'].includes(row.id)) ||
        new Set(rows.map(row => row.id)).size !== rows.length || rows.filter(row => row.selected).length !== 1) return null;
    return rows;
  }
  async function readNativeThinking(current) {
    if (!current()) return null;
    const trigger = nativeThinkingTrigger();
    if (!trigger) return { efforts: [], selected: null };
    const owned = trigger.getAttribute('aria-expanded') !== 'true';
    if (owned) trigger.click();
    const rows = await waitFor(() => nativeThinkingMenu(trigger), current, 5000);
    if (owned && current() && trigger.isConnected && trigger.getAttribute('aria-expanded') === 'true') {
      trigger.click();
      if (!await waitFor(() => !trigger.isConnected || trigger.getAttribute('aria-expanded') !== 'true' || !nativeModelRows().length,
          current, 3000)) return null;
    }
    return rows && current() ? { efforts: rows.map(row => row.id), selected: rows.find(row => row.selected).id } : null;
  }
  function modelSurface(current) {
    const picker = pickerButton(), box = composer(), route = location.href, draft = box?.textContent, files = attachmentRows();
    const ownsDraft = () => current() && Boolean(box) && composer() === box && box.isConnected && location.href === route &&
      box.textContent === draft && attachmentRows().length === files.length && files.every(node => attachmentRows().includes(node));
    return { picker, ownsDraft, current: () => ownsDraft() && pickerButton() === picker };
  }
  async function closeModelMenu(picker, current, owned, settled = () => true, timeout = 3000) {
    if (!owned) return true;
    if (!nativeModelRows().length) return Boolean(await waitFor(settled, current, timeout));
    if (!current() || !enabled(picker)) return false;
    picker.click();
    return Boolean(await waitFor(() => nativeModelRows().length === 0 && settled(), current, timeout));
  }
  async function inspectModelSettings(current = () => true, failure = null) {
    const surface = modelSurface(current), picker = surface.picker;
    if (!surface.current() || !enabled(picker) || generating()) { failure?.('picker_unavailable'); return null; }
    const owned = nativeModelRows().length === 0;
    if (owned) picker.click();
    let interrupted = false;
    const interrupt = event => { if (event.isTrusted) interrupted = true; };
    const interruptions = ['pointerdown', 'keydown', 'beforeinput', 'input'];
    for (const type of interruptions) document.addEventListener(type, interrupt, true);
    const owns = () => !interrupted && surface.ownsDraft() && !generating();
    let original = null, originalEffort = null, originalThinkingOpen = false, switched = false, restored = true, problem = null, models = null;
    const open = async () => {
      const trigger = pickerButton();
      if (!owns() || !enabled(trigger)) return null;
      if (!nativeModelRows().length) trigger.click();
      return await waitFor(nativeModelMenu, () => owns() && pickerButton() === trigger, 5000);
    };
    try {
      const rows = await waitFor(nativeModelMenu, surface.current, 5000);
      if (!rows || !surface.current() || !owns()) problem = 'model_unconfirmed';
      else {
        original = rows.find(row => row.selected);
        originalThinkingOpen = nativeThinkingTrigger()?.getAttribute('aria-expanded') === 'true';
        const thinking = await readNativeThinking(owns);
        if (!thinking) problem = 'model_unconfirmed';
        else {
          originalEffort = thinking.selected;
          const observed = [];
          for (const row of rows) {
            if (!owns()) { problem = 'model_unconfirmed'; break; }
            if (!nativeModelMenu()?.some(choice => choice.id === row.id && choice.selected)) {
              switched = true;
              if (!await selectModelSettings(row.id, null, owns)) { problem = 'model_unconfirmed'; break; }
            }
            const live = await open();
            if (!live?.some(choice => choice.id === row.id && choice.label === row.label && choice.selected)) { problem = 'model_unconfirmed'; break; }
            const levels = row.id === original.id && !switched ? thinking : await readNativeThinking(owns);
            if (!levels || !owns()) { problem = 'model_unconfirmed'; break; }
            observed.push({ id: row.id, label: row.label, efforts: levels.efforts });
          }
          if (!problem && observed.length === rows.length) models = observed;
        }
      }
    } finally {
      try {
        // Discovery may inspect different model-specific Thinking menus. Restore
        // only through this original draft/route owner, including its exact effort.
        // A cancellation or human draft never grants a restoration mutation.
        if (switched) restored = Boolean(original && owns() && await selectModelSettings(original.id, originalEffort, owns));
        if (restored && owns()) {
          if (owned) restored = await closeModelMenu(pickerButton(), owns, true);
          else {
            const rows = await open();
            restored = Boolean(rows && (!original || rows.some(row => row.id === original.id && row.selected)));
            if (restored && originalThinkingOpen) {
              const trigger = nativeThinkingTrigger();
              if (!trigger) restored = false;
              else {
                if (trigger.getAttribute('aria-expanded') !== 'true') trigger.click();
                restored = Boolean(await waitFor(() => nativeThinkingMenu(trigger)?.some(row => row.id === originalEffort && row.selected), owns, 5000));
              }
            }
          }
        } else restored = false;
      } finally { for (const type of interruptions) document.removeEventListener(type, interrupt, true); }
    }
    if (!models || !restored || !owns()) { failure?.(!restored ? 'restore_failed' : problem || 'model_unconfirmed'); return null; }
    return [{ id: 'gemini-current', label: 'Automatic (current Gemini model)', efforts: [] }, ...models];
  }
  async function selectModelSettings(model, effort, current = () => true, failure = null) {
    const initial = modelSurface(current);
    const refuse = (stage, surface = initial) => {
      failure?.(stage);
      const picker = pickerButton(), rows = nativeModelMenu();
      console.info('[OneCode model] ' + JSON.stringify({ stage,
        requestedModel: model === 'gemini-current' ? model : /^[0-9a-f]{16}$/i.test(String(model)) ? String(model).toLowerCase() : 'other',
        callerCurrent: current(), draftCurrent: initial.ownsDraft(), surfaceCurrent: surface.current(),
        pickerPresent: Boolean(picker), pickerEnabled: enabled(picker), pickerReadable: Boolean(visibleModelSelection()?.model),
        nativeGenerating: generating(), menuRows: nativeModelRows().length, confirmedChoices: rows?.length || 0,
        requestedChoiceSelected: Boolean(rows?.some(row => row.id === String(model).toLowerCase() && row.selected))
      }));
      return false;
    };
    if (!current() || (effort != null && !['low', 'medium', 'high'].includes(effort))) return refuse('request-unavailable');
    const requestedEffort = effort ?? null;
    if (!model && !requestedEffort) return true;
    // The fresh native editor can become writable before its model control is
    // mounted/readable. Wait under the original claim and exact draft lease;
    // observing that later control grants no authority to replace either one.
    let picker = await waitFor(() => {
      const candidate = pickerButton();
      return enabled(candidate) && visibleModelSelection()?.model ? candidate : null;
    }, () => initial.ownsDraft() && !generating(), 5000);
    if (!picker) return refuse('picker-not-ready');
    let choiceClicked = false, pickerRebound = false, closingConfirmedId = null, confirmedId = null, confirmedLabel = null, provedPicker = null;
    const surface = { current: () => {
      if (!initial.ownsDraft() || generating()) return false;
      const next = pickerButton();
      if (next === picker) return true;
      // Selecting a native mode or closing its proved menu can remount its
      // header. Follow one replacement only after our own transition, under the
      // unchanged editor/draft/route/attachments and original caller claim.
      // A missing/readiness-pending successor may wait within the same budget;
      // no control is clicked until its actual native selection is re-proved.
      if ((!choiceClicked && !closingConfirmedId) || pickerRebound || picker.isConnected) return false;
      const candidates = all('button[aria-label^="Open mode picker"]').filter(shown);
      if (candidates.length > 1) return false;
      if (!next || !enabled(next) || !visibleModelSelection()?.model) return true;
      picker = next; pickerRebound = true;
      return true;
    } };
    if (!surface.current()) return refuse('picker-changed', surface);
    if (model === 'gemini-current' && !requestedEffort) return true;
    let owned = nativeModelRows().length === 0;
    if (owned) picker.click();
    let confirmEffort = async () => !requestedEffort;
    try {
      const rows = await waitFor(nativeModelMenu, surface.current, 5000);
      const options = rows?.filter(row => !model || model === 'gemini-current' ? row.selected :
        row.id === String(model).toLowerCase() || row.label === model) || [];
      if (options.length !== 1 || !surface.current()) return refuse('choice-unconfirmed', surface);
      const target = options[0];
      confirmEffort = async () => {
        if (!requestedEffort) { provedPicker = picker; return true; }
        let trigger = nativeThinkingTrigger();
        if (!trigger || !surface.current()) return false;
        let thinkingOwned = trigger.getAttribute('aria-expanded') !== 'true';
        if (thinkingOwned) trigger.click();
        try {
          const rows = await waitFor(() => nativeThinkingMenu(trigger), surface.current, 5000);
          const choice = rows?.find(row => row.id === requestedEffort);
          if (!choice || !surface.current()) return false;
          if (!choice.selected) {
            choiceClicked = true; choice.node.click();
            const changed = await waitFor(() => !nativeThinkingMenu(trigger) || nativeThinkingMenu(trigger)?.some(row => row.id === requestedEffort && row.selected),
              surface.current, 5000);
            if (!changed || !await waitFor(() => picker.isConnected && pickerButton() === picker && enabled(picker), surface.current, 5000)) return false;
            if (!nativeModelRows().length) { picker.click(); owned = true; }
            if (!await waitFor(() => nativeModelMenu()?.some(row => row.id === target.id && row.selected) &&
                modelPickerLaneCurrent(picker, target.label), surface.current, 5000)) return false;
            trigger = nativeThinkingTrigger();
            if (!trigger) return false;
            if (trigger.getAttribute('aria-expanded') !== 'true') { trigger.click(); thinkingOwned = true; }
          }
          const proven = Boolean(await waitFor(() => nativeThinkingMenu(trigger)?.some(row => row.id === requestedEffort && row.selected) &&
            nativeModelMenu()?.some(row => row.id === target.id && row.selected) && modelPickerLaneCurrent(picker, target.label), surface.current, 5000));
          if (proven) provedPicker = picker;
          return proven;
        } finally {
          if (thinkingOwned && surface.current() && trigger?.isConnected && trigger.getAttribute('aria-expanded') === 'true') {
            closingConfirmedId = confirmedId;
            trigger.click();
            if (!await waitFor(() => !trigger.isConnected || trigger.getAttribute('aria-expanded') !== 'true' || !nativeModelRows().length,
                surface.current, 3000)) return false;
          }
        }
      };
      if (target.selected) {
        const settled = await waitFor(() => nativeModelMenu()?.some(row => row.id === target.id && row.selected) &&
          modelPickerLaneCurrent(picker, target.label), surface.current, 5000);
        if (!settled) return refuse('selected-caption-unconfirmed', surface);
        confirmedId = target.id; confirmedLabel = target.label;
        return await confirmEffort() || refuse('effort-choice-unconfirmed', surface);
      }
      choiceClicked = true; target.node.click();
      // The closed trigger says only Gemini/Flash, while native choices have
      // distinct versions. Reopen and prove the actual selected mode ID.
      const changed = await waitFor(() => picker.isConnected && pickerButton() === picker &&
        (nativeModelRows().length === 0 || nativeModelMenu()?.some(row => row.id === target.id && row.selected)), surface.current, 5000);
      if (!changed || !surface.current()) return refuse('choice-did-not-change', surface);
      if (!nativeModelRows().length) { picker.click(); owned = true; }
      const selected = await waitFor(() => nativeModelMenu()?.some(row => row.id === target.id && row.selected) &&
        modelPickerLaneCurrent(picker, target.label), surface.current, 5000);
      if (selected) { confirmedId = target.id; confirmedLabel = target.label; }
      return !selected ? refuse('selected-choice-unconfirmed', surface) : await confirmEffort() || refuse('effort-choice-unconfirmed', surface);
    } finally {
      const closeUntil = Date.now() + 3000;
      closingConfirmedId = confirmedId;
      const pickerSettled = () => picker.isConnected && pickerButton() === picker &&
        (!confirmedId || modelPickerLaneCurrent(picker, confirmedLabel));
      if (!await closeModelMenu(picker, surface.current, owned, pickerSettled)) return refuse('picker-close-failed', surface);
      // Closing our own menu may also replace the header when no choice click
      // was necessary. Re-prove the exact ID on that one successor before
      // returning success, within the original close budget and draft lease.
      if (provedPicker && provedPicker !== picker) {
        if (!closingConfirmedId || !surface.current() || !enabled(picker)) return refuse('picker-close-failed', surface);
        picker.click();
        const selected = await waitFor(() => nativeModelMenu()?.some(row => row.id === closingConfirmedId && row.selected &&
          modelPickerLaneCurrent(picker, row.label)),
          surface.current, Math.max(0, closeUntil - Date.now()));
        if (!selected) return refuse('selected-choice-unconfirmed', surface);
        if (!await confirmEffort()) return refuse('effort-choice-unconfirmed', surface);
        if (!await closeModelMenu(picker, surface.current, true, pickerSettled, Math.max(0, closeUntil - Date.now())))
          return refuse('picker-close-failed', surface);
        if (provedPicker !== picker) return refuse('selected-choice-unconfirmed', surface);
      }
    }
  }
  const newChatControl = async (current = () => true) => current() ? unique(all('a[href][aria-label="New chat"],button[aria-label="New chat"]').filter(node => {
    if (node.tagName === 'BUTTON') return true;
    const url = new URL(node.href, location.href);
    return url.origin === 'https://gemini.google.com' && isAppHomePath(url.pathname);
  })) : null;
  const errors = () => all('[role="alert"]').filter(node => shown(node) && !node.closest(TURN)).map(node => {
    const notice = text(node).slice(0, 2000).replace(/\s+/g, ' ').trim();
    // A transport failure can be refreshed; quota/account notices cannot. Unknown
    // alerts stay blocking. Ordinary assistant/user prose never enters this path.
    const transport = /^(?:something went wrong(?:\. please try again(?: later)?)?|a network error occurred(?:\. please check your connection and try again)?|network error|connection (?:lost|interrupted)|unable to connect|there was a problem generating (?:a|the) response)(?:[.!])?(?: (?:try again|retry))?$/i.test(notice);
    return { node, text: notice, recoverable: transport, blocking: !transport };
  });
  const conversationTitle = () => document.title.replace(/\s*[-–]\s*(?:Google )?Gemini\s*$/, '').trim();
  const composerActions = () => {
    const button = sendButton() || stopButton() || unique(all('button[aria-label^="Dictate"]'));
    return button?.parentElement ? { host: button.parentElement, before: button } : null;
  };
  const toolBlocks = turn => all('tool-call,[data-tool-call-id]', turn?.node || document);
  return {
    provider: 'gemini', TURN_SELECTOR: TURN, AUTHORED_SELECTOR: 'message-content,.query-text',
    conversationFromPath, isAppHomePath, conversationId, conversationTitle, turnIdOf, messageIdOf, turns, presentationTurns: turns, messages, messagesIn, messageComplete, completedResponseReceipt, recoveryTerminalReceipt,
    nativeOutputs, nativeImageNode, exportNativeImage, nativeVideoNode, nativeVideoDescriptorCurrent, readNativeArtifacts,
    sectionSignature: node => `${turnIdOf(node) || ''}:${text(node).length}`, composer, composerBox, composerWritable,
    composerVisible: () => shown(composer()), composerSubmitReady, composerAuthoredText, composerActions,
    composerStack: () => { const box = composerBox(); return box?.parentElement ? { host: box.parentElement, before: box } : null; },
    userPromptText, presentUserPrompts: () => {}, userMessageReaction: () => undefined,
    firstUserMessage: () => turns().find(turn => turn.role === 'user')?.node || null,
    insertPrompt, clearPromptExact, captureComposerDraft, send, sendButton, stopButton, stopGeneration, generating,
    setConnectorNames, connectorNames, setConnectorApps, connectorApps, setBindingResolver, setOpeningClaim, setInputClaim, setCommandClaim, setGoalClaim, preparedConversation,
    setWarmupRecoveryResolver, setWarmupInitializationResolver, warmupRecoveryState, warmupInitializationState, warmupRecoveryPending, resumeWarmupRecovery, selectConnector, confirmedMention,
    approvalCard, answerApprovalCard, approvalWaiting, maybeAutoApprove, approvalIssue, approvalObservations: () => [...approvalObservations],
    setApprovalReceiptStore: (store, restored) => { approvalReceiptStore = store; approvalReceiptsRestored = restored; approvalReceiptRoute = null; },
    approvalReceiptsReady, flushApprovalReceipts,
    approvalAudit: () => approvalAudit.map(row => ({ ...row })),
    hasComposerAttachments, composerAttachmentNames, uploadImages, visibleModelSelection, inspectModelSettings, selectModelSettings,
    newChatControl, prepareChatModelSurface: async current => current() && Boolean(composer()), modelPickerReadable: async () => Boolean(pickerButton()),
    conversationLoadFailure: () => null, errors, temporaryChatReady: () => false, localHelperReady: () => localHelper && Boolean(composer()),
    helperHistory: 'normal-provider-history', confirmTemporaryChatIntroduction: () => {},
    projectHomeId: () => null, projectCreateControl: () => null, projectCreateForm: () => null, projectIdsShown: () => [],
    revealSidebar: () => false, fillProjectName: () => false, enterProject: async () => false,
    pluginRefreshView: async () => null, pluginInstalledButtons: () => null, pluginManagementIdle: () => false,
    pageTheme: () => document.documentElement.classList.contains('dark-theme') || document.body.classList.contains('dark-theme') ? 'dark' : 'light',
    clearRevivalResidue: () => false, progressLine: () => null, progressItems: () => [], interrupted: () => false, markProgress: () => {},
    toolBlocks, activityItems: () => [], isConnectorBlock: () => false, markLocalBlock: () => {}, hasConnectorRow: () => false,
    connectorRows: () => [], fiberRef: () => null, activitySummaryRows: () => [], thoughtActivityRows: () => [], toolLabel: text,
    hideProgress: () => {}, hideActivity: () => {}, activityFold: () => null, collapsedActivityFold: () => null,
    canHideActivity: () => false, replaceActivity: () => {}
  };
})();
