/** Bounded projection of native generated-file sources and public HTML exports.
 * Does not read requests, cookies, hidden analysis, React callbacks or provider APIs. */
(() => {
  'use strict';
  const VERSION = 16;
  if (globalThis.__ONECODE_CLAUDE_NATIVE__?.version >= VERSION) return;
  globalThis.__ONECODE_CLAUDE_NATIVE__?.stop?.();
  const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  const uuid = new RegExp(`^${UUID}$`, 'i'), suffix = new RegExp(`(?:^|_)(${UUID})$`, 'i');
  const own = (value, key) => {
    if (!value || typeof value !== 'object') return undefined;
    const property = Object.getOwnPropertyDescriptor(value, key); return property && 'value' in property ? property.value : undefined;
  };
  const shown = node => Boolean(node?.isConnected && !node.closest('[hidden],[aria-hidden="true"],[inert],[data-clf-root],.clf-stream,.clf-stage,.clf-composer') &&
    node.getClientRects().length && getComputedStyle(node).display !== 'none' && getComputedStyle(node).visibility !== 'hidden');
  function safePath(value) {
    if (typeof value !== 'string' || value.length > 600 || !value.startsWith('/mnt/user-data/outputs/') || /[\\\u0000-\u001f\u007f?#]/.test(value)) return null;
    const parts = value.slice('/mnt/user-data/outputs/'.length).split('/');
    return parts.every(part => part && part !== '.' && part !== '..') ? value : null;
  }
  function fileOf(props) {
    const file = own(props, 'file'), path = safePath(own(file, 'path')), name = own(file, 'name');
    return path && typeof name === 'string' && name.length > 0 && name.length <= 256 && !/[\\/\u0000-\u001f\u007f]/.test(name)
      ? { path, name } : null;
  }
  function propsAt(node) {
    const keys = Object.getOwnPropertyNames(node).filter(key => key.startsWith('__reactFiber$'));
    if (keys.length !== 1) return [];
    const path = [], seen = new Set(); let fiber = own(node, keys[0]), base = null, paired = false;
    // A mounted DOM pointer can retain React's previous render. Prove the same
    // committed root/child path used by the existing provider recorder; never
    // merge arbitrary alternate props or mutate React's return links.
    while (fiber && path.length < 2048) {
      if (seen.has(fiber)) return [];
      seen.add(fiber); const alternate = own(fiber, 'alternate'); paired ||= Boolean(alternate);
      if (own(fiber, 'tag') === 3) {
        const root = own(fiber, 'stateNode'), current = own(root, 'current');
        if (!current || current !== fiber && current !== alternate) return [];
        base = { root, current, node: current }; break;
      }
      path.push(fiber); fiber = own(fiber, 'return');
    }
    let committed;
    if (!base) {
      // Older unpaired public owner facades have no root bookkeeping. Real or
      // double-buffered React fibers must always prove their committed root.
      if (fiber || paired || path.some(value => typeof own(value, 'tag') === 'number')) return [];
      committed = path;
    } else {
      committed = [base.current]; let budget = 4096;
      for (let index = path.length - 1; index >= 0; index--) {
        const wanted = path[index], alternate = own(wanted, 'alternate'); let selected = null;
        for (let child = own(base.node, 'child'); child; child = own(child, 'sibling')) {
          if (--budget < 0) return [];
          if (child !== wanted && child !== alternate) continue;
          if (selected) return []; selected = child;
        }
        if (!selected || own(base.root, 'current') !== base.current) return [];
        committed.push(selected); base.node = selected;
      }
      if (own(base.node, 'stateNode') !== node) return [];
      committed.reverse();
    }
    const result = [];
    for (const fiber of committed.slice(0, 40)) {
      const props = own(fiber, 'memoizedProps');
      if (props && typeof props === 'object') result.push(props);
    }
    return result;
  }
  const uniqueValue = values => {
    const distinct = [...new Map(values.map(value => [JSON.stringify(value), value])).values()];
    return distinct.length === 1 ? distinct[0] : null;
  };
  const userSourceTraces = new WeakMap();
  function userSourceTrace(node, snapshot, ready = false) {
    const previous = userSourceTraces.get(node) || { firstFailure: null, firstCandidateFailure: null, lastFailure: null, ready: null };
    if (ready) previous.ready = snapshot;
    else {
      previous.firstFailure ||= snapshot;
      if (snapshot.turnCandidates > 0) previous.firstCandidateFailure ||= snapshot;
      previous.lastFailure = snapshot;
    }
    userSourceTraces.set(node, previous);
    try { node.setAttribute('data-onecode-claude-user-source-trace', JSON.stringify(previous)); } catch { /* Bounded fixed gate diagnostics only. */ }
  }
  const valueType = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  function descriptorType(value, key) {
    if (!value || !['object', 'function'].includes(typeof value)) return 'not-object';
    const property = Object.getOwnPropertyDescriptor(value, key);
    return !property ? 'missing' : 'value' in property ? 'value' : 'getter' in property && typeof property.get === 'function' ? 'getter' : 'accessor';
  }
  function projectUser(message) {
    const diagnostic = (stage, flags = {}) => { try { document.documentElement.setAttribute('data-onecode-claude-user-source-diagnostic', JSON.stringify({ stage, ...flags })); } catch { /* Fixed read-only state flags. */ } };
    const chat = new RegExp(`^/chat/(${UUID})/?$`, 'i').exec(location.pathname)?.[1]?.toLowerCase();
    if (location.origin !== 'https://claude.ai' || !chat || !uuid.test(message || '')) { diagnostic('route-unavailable'); return null; }
    const matches = [...document.querySelectorAll('[data-testid="user-message"]')].filter(node => shown(node) &&
      !node.parentElement?.closest('[data-testid="user-message"],[data-testid="assistant-message"]') &&
      suffix.exec(node.id || '')?.[1]?.toLowerCase() === message);
    if (matches.length !== 1) { diagnostic('row-unavailable', { matches: matches.length }); return null; }
    const node = matches[0];
    const bodies = node.querySelectorAll(':scope > div.contents').length;
    if (bodies === 0) { diagnostic('body-unavailable', { bodies }); return null; }
    const props = propsAt(node), samples = [], counts = { turnCandidates: 0, matchingIds: 0, nativeHumanIds: 0, userRoles: 0, arrays: 0, soleItems: 0, eligibleSources: 0 };
    const sources = props.flatMap((props, depth) => {
      const row = own(props, 'row');
      const candidates = [own(props, 'turn'), own(row, 'kind') === 'turn' ? own(row, 'turn') : null];
      return candidates.flatMap((turn, origin) => {
        if (turn !== undefined && turn !== null) {
          const turnId = own(turn, 'id'), role = own(turn, 'role'), items = role === 'user' ? own(turn, 'items') : undefined;
          const item = role === 'user' ? own(items, '0') : undefined, itemId = own(item, 'id'), body = role === 'user' ? own(item, 'text') : undefined;
          const matching = turnId === message, userRole = role === 'user', array = Array.isArray(items), sole = array && items.length === 1;
          const nativeHuman = turnId === `new-human-message-uuid-${message}`;
          counts.turnCandidates++; if (matching) counts.matchingIds++; if (nativeHuman) counts.nativeHumanIds++; if (userRole) counts.userRoles++; if (array) counts.arrays++; if (sole) counts.soleItems++;
          if (samples.length < 4) samples.push({ depth, origin: origin === 0 ? 'turn' : 'row.turn', turnType: valueType(turn),
            turnDescriptor: descriptorType(origin === 0 ? props : row, 'turn'), turnIdDescriptor: descriptorType(turn, 'id'),
            turnIdType: valueType(turnId), turnIdExact: matching, turnIdCaseFolded: typeof turnId === 'string' && turnId.toLowerCase() === message,
            turnIdNativeUserWrapper: turnId === `new-user-message-uuid-${message}`,
            turnIdNativeHumanWrapper: nativeHuman,
            turnIdChars: typeof turnId === 'string' ? turnId.length : null,
            turnIdEndsNative: typeof turnId === 'string' && turnId.endsWith(message),
            turnIdPrefixChars: typeof turnId === 'string' && turnId.endsWith(message) ? turnId.length - message.length : null,
            userRole, roleType: valueType(role), itemsDescriptor: descriptorType(turn, 'items'), itemsType: valueType(items),
            itemCount: array && Number.isSafeInteger(items.length) && items.length <= 256 ? items.length : null,
            indexDescriptor: descriptorType(items, '0'), itemType: valueType(item), itemIdDescriptor: descriptorType(item, 'id'),
            itemIdType: valueType(itemId), itemIdExact: itemId === `${message}:0`,
            itemIdNativeUserWrapper: itemId === `new-user-message-uuid-${message}:0`,
            itemIdChars: typeof itemId === 'string' ? itemId.length : null,
            itemIdEndsNative: typeof itemId === 'string' && itemId.endsWith(`${message}:0`),
            itemIdPrefixChars: typeof itemId === 'string' && itemId.endsWith(`${message}:0`) ? itemId.length - message.length - 2 : null,
            textKind: own(item, 'kind') === 'text', plainFormat: own(item, 'format') === 'plain',
            textDescriptor: descriptorType(item, 'text'), textType: valueType(body), textChars: typeof body === 'string' ? body.length : null });
        }
        // During a live reply Claude retains this exact witnessed temporary
        // wrapper on turn.id while the mounted row and sole item already have
        // their real UUID. No other prefix, suffix or casing is normalized.
        const turnId = own(turn, 'id');
        if ((turnId !== message && turnId !== `new-human-message-uuid-${message}`) || own(turn, 'role') !== 'user') return [];
        const items = own(turn, 'items');
        if (!Array.isArray(items) || !items.length || items.length > 21) return [];
        // A question with files may have public media items beside its text.
        // Read only the sole plain text item and its exact native item identity;
        // never flatten media, concatenate arbitrary items or read their payloads.
        const texts = [];
        for (let index = 0; index < items.length; index++) {
          const item = own(items, String(index));
          if (own(item, 'kind') === 'text') texts.push({ item, index });
        }
        if (texts.length !== 1) return [];
        const { item, index } = texts[0], text = own(item, 'text');
        const itemId = own(item, 'id');
        // Text can retain its own zero-based index when Claude mounts a media
        // item before it. Both forms still identify the same committed turn.
        const itemIds = new Set([`${message}:${index}`, `${turnId}:${index}`, `${message}:0`, `${turnId}:0`]);
        let duplicateId = false;
        for (let position = 0; position < items.length; position++) {
          if (position !== index && own(own(items, String(position)), 'id') === itemId) duplicateId = true;
        }
        const eligible = itemIds.has(itemId) && !duplicateId && own(item, 'format') === 'plain' &&
          typeof text === 'string' && text.length > 0 && text.length <= 240000;
        if (eligible) counts.eligibleSources++;
        return eligible ? [{ text }] : [];
      });
    });
    const source = uniqueValue(sources);
    userSourceTrace(node, { at: Date.now(), props: props.length, ...counts, samples }, Boolean(source));
    if (!source) { diagnostic('source-unavailable', { props: props.length, candidates: sources.length,
      fiberKeys: Object.getOwnPropertyNames(node).filter(key => key.startsWith('__reactFiber$')).length }); return null; }
    let token = node.getAttribute('data-clf-claude-user-token');
    if (!uuid.test(token || '')) { token = crypto.randomUUID(); node.setAttribute('data-clf-claude-user-token', token); }
    diagnostic('ready', { props: props.length, candidates: sources.length });
    return { conversation: chat, message, token, text: source.text };
  }
  /** Only a mounted public visualize frame can expose its authored widget source.
   * Never walk message.content, tool-result payloads, stores or the frame's URL. */
  function projectWidgets(conversation) {
    const widgets = [];
    for (const node of [...document.querySelectorAll('[id^="mcp-app-container-toolu_"]')].slice(-32)) {
      if (!shown(node)) continue;
      const toolUseId = node.id.slice('mcp-app-container-'.length);
      if (!/^toolu_[A-Za-z0-9]{20,100}$/.test(toolUseId)) continue;
      const frames = [...node.querySelectorAll('iframe')].filter(shown);
      if (frames.length !== 1 || !frames[0].title.startsWith('visualize: ')) continue;
      const message = node.closest('[data-testid="assistant-message"]');
      const native = suffix.exec(message?.id || '')?.[1]?.toLowerCase();
      if (!native || message.getAttribute('data-turn-key')?.toLowerCase() !== native) continue;
      const source = uniqueValue(propsAt(node).flatMap(props => {
        const input = own(props, 'input'), result = own(props, 'toolResult'), owner = own(props, 'message');
        const content = own(input, 'widget_code'), streaming = own(props, 'isStreaming');
        return own(props, 'toolName') === 'visualize:show_widget' && own(props, 'toolUseId') === toolUseId &&
          own(props, 'conversationUuid') === conversation && own(owner, 'uuid') === native && own(owner, 'sender') === 'assistant' &&
          own(result, 'type') === 'tool_result' && own(result, 'name') === 'visualize:show_widget' &&
          own(result, 'tool_use_id') === toolUseId && own(result, 'is_error') === false &&
          typeof streaming === 'boolean' && typeof content === 'string' && content.length > 0 && content.length <= 240000
          ? [{ content, streaming }] : [];
      }));
      if (!source) continue;
      let token = node.getAttribute('data-clf-claude-widget-token');
      if (!uuid.test(token || '')) { token = crypto.randomUUID(); node.setAttribute('data-clf-claude-widget-token', token); }
      widgets.push({ conversation, message: native, toolUseId, token, title: frames[0].title.slice(11, 211), ...source });
    }
    return widgets;
  }
  function projectMermaids(conversation) {
    const diagrams = [];
    for (const row of [...document.querySelectorAll('[data-testid="assistant-message"]')].slice(-32)) {
      const message = suffix.exec(row.id || '')?.[1]?.toLowerCase();
      if (!message || row.getAttribute('data-turn-key')?.toLowerCase() !== message || row.getAttribute('data-is-streaming') !== 'false' || !shown(row)) continue;
      const hosts = [...row.querySelectorAll('[data-mermaid="true"][role="img"][aria-label="Mermaid diagram"]')];
      if (hosts.length > 32) continue;
      for (const [index, host] of hosts.entries()) {
        if (!shown(host) || host.closest('[data-testid="assistant-message"]') !== row ||
            host.closest('[data-cds="TurnStatus"],[data-find-omitted],button') || !host.closest('[data-cds="Prose"]')) continue;
        const shadow = host.shadowRoot, roots = shadow ? [...shadow.querySelectorAll('svg')] : [];
        if (roots.length !== 1 || !/^mermaid-[A-Za-z0-9_-]{1,160}$/.test(roots[0].id) || !roots[0].getAttribute('aria-roledescription') || shadow.querySelectorAll('*').length > 2000) continue;
        const box = host.getBoundingClientRect();
        if (!Number.isFinite(box.width) || box.width <= 0 || box.width > 1600 || !Number.isFinite(box.height) || box.height <= 0 || box.height > 16000) continue;
        const result = document.implementation.createHTMLDocument('Mermaid diagram'), copy = result.createElement('div');
        copy.setAttribute('data-mermaid', 'true'); copy.setAttribute('role', 'img'); copy.setAttribute('aria-label', 'Mermaid diagram');
        const computed = getComputedStyle(host);
        for (const property of ['box-sizing','padding','border-top','border-right','border-bottom','border-left','border-radius',
          'background-color','color','font-family','font-size','font-weight','line-height','letter-spacing','direction','text-align','overflow-x'])
          copy.style.setProperty(property, computed.getPropertyValue(property));
        copy.style.width = `${Math.ceil(box.width)}px`; copy.style.maxWidth = '100%';
        for (const child of shadow.childNodes) copy.append(result.importNode(child, true));
        // The prose host uses a different font from the diagram's SVG. Freeze
        // the SVG's rendered inheritance so leaving its shadow root cannot make
        // labels inherit the surrounding prose face.
        const svgCopy = copy.querySelector('svg'), svgStyle = getComputedStyle(roots[0]);
        for (const property of ['font-family','font-size','font-weight','font-style','line-height','letter-spacing','color','fill']) {
          const value = svgStyle.getPropertyValue(property);
          if (value && value.length <= 8192 && !/url\(|@import/i.test(value)) svgCopy.style.setProperty(property, value);
        }
        for (const node of copy.querySelectorAll('script,iframe,object,embed,link,meta,base,form,input,button,select,textarea')) node.remove();
        for (const node of copy.querySelectorAll('*')) for (const attr of [...node.attributes])
          if (/^on/i.test(attr.name) || /^(?:href|xlink:href|src|srcset|action)$/i.test(attr.name) && !attr.value.startsWith('#')) node.removeAttribute(attr.name);
        let background = getComputedStyle(document.documentElement).getPropertyValue('color-scheme').includes('dark') ? '#191919' : '#fff';
        for (let parent = host.parentElement; parent; parent = parent.parentElement) {
          const color = getComputedStyle(parent).backgroundColor;
          if (/^rgb\(/.test(color) || /^rgba\([^)]*,\s*1\)$/.test(color)) { background = color; break; }
        }
        result.body.style.cssText = 'margin:0;padding:0'; result.body.style.backgroundColor = background;
        result.body.append(copy);
        const content = '<!doctype html>' + result.documentElement.outerHTML;
        if (content.length > 240000) continue;
        let token = host.getAttribute('data-clf-claude-diagram-token');
        if (!uuid.test(token || '')) { token = crypto.randomUUID(); host.setAttribute('data-clf-claude-diagram-token', token); }
        diagrams.push({ conversation, message, token, index, svgId: roots[0].id, content });
        if (diagrams.length >= 32) return diagrams;
      }
    }
    return diagrams;
  }
  const frameExports = new WeakMap();
  function projectFrames(conversation) {
    const cards = [];
    for (const node of [...document.querySelectorAll('[data-testid="frame-card-open"][data-cds="CardLink"][role="button"]')].slice(-32)) {
      if (!shown(node) || !node.closest('[data-file-row-card]')) continue;
      const message = node.closest('[data-testid="assistant-message"]'), native = suffix.exec(message?.id || '')?.[1]?.toLowerCase();
      if (!native || message.getAttribute('data-turn-key')?.toLowerCase() !== native) continue;
      const metadata = uniqueValue(propsAt(node).flatMap(props => {
        const input = own(props, 'input'), result = own(props, 'toolResult'), owner = own(props, 'message');
        const structured = own(result, 'structured_content'), display = own(result, 'display_content');
        const path = safePath(own(input, 'file_path')), frameId = own(structured, 'artifact_id'), tool = own(props, 'toolUseId');
        if (!path || !/\.html?$/i.test(path) || !uuid.test(frameId || '') || !/^toolu_[A-Za-z0-9]{20,100}$/.test(tool || '') ||
            own(props, 'conversationUuid') !== conversation || own(owner, 'uuid') !== native || own(owner, 'sender') !== 'assistant' ||
            own(props, 'toolName') !== 'Artifact' || own(input, 'action') !== 'publish' || own(result, 'name') !== 'Artifact' ||
            own(result, 'type') !== 'tool_result' || own(result, 'tool_use_id') !== tool || own(result, 'is_error') !== false ||
            own(result, 'tool_origin') !== 'first_party' || own(structured, 'path') !== path || own(display, 'type') !== 'file' ||
            own(display, 'published_artifact_id') !== frameId || own(display, 'published_url') !== `https://claude.ai/code/artifact/${frameId}`) return [];
        return [{ path, name: path.split('/').at(-1), frameId, conversation, message: native }];
      }));
      if (!metadata) continue;
      let token = node.getAttribute('data-clf-claude-file-token');
      if (!uuid.test(token || '')) { token = crypto.randomUUID(); node.setAttribute('data-clf-claude-file-token', token); }
      const label = node.getAttribute('aria-label') || '';
      cards.push({ ...metadata, token, selected: node.getAttribute('aria-current') === 'true',
        title: label.startsWith('View ') ? label.slice(5, 205) : metadata.name,
        streaming: message.getAttribute('data-is-streaming') !== 'false' });
    }
    return cards;
  }
  const frameCardNode = card => [...document.querySelectorAll('[data-testid="frame-card-open"]')]
    .find(node => node.getAttribute('data-clf-claude-file-token') === card.token);
  function frameViewer(card) {
    if (!card.selected || card.streaming || new URL(location.href).searchParams.get('artifact') !== card.frameId) return null;
    const frames = [...document.querySelectorAll('iframe')].filter(frame => {
      try { const url = new URL(frame.src); return shown(frame) && url.origin === location.origin && url.pathname === `/code/artifact/${card.frameId}`; } catch { return false; }
    });
    if (frames.length !== 1 || frames[0].contentDocument?.documentElement.getAttribute('data-frame-uuid') !== card.frameId) return null;
    return frames[0];
  }
  const activeFrameReads = new Set();
  async function captureSelectedFrame() {
    const match = new RegExp(`^/chat/(${UUID})/?$`, 'i').exec(location.pathname);
    if (location.origin !== 'https://claude.ai' || !match) return;
    const conversation = match[1].toLowerCase(), selected = projectFrames(conversation).filter(card => card.selected);
    if (selected.length !== 1) return;
    const card = selected[0], node = frameCardNode(card), frame = frameViewer(card);
    if (!node || !frame) return;
    const previous = frameExports.get(node);
    if (previous) { await previous.promise; return; }
    const route = location.href, doc = frame.contentDocument;
    const toolbars = [...document.querySelectorAll('[role="toolbar"]')].filter(toolbar =>
      toolbar.getAttribute('aria-label') === `${card.title} controls` && toolbar.querySelector('[data-testid="frame-drawer-title-menu"]'));
    const buttons = toolbars.length === 1 ? [...toolbars[0].querySelectorAll('button[aria-label="Export"]')].filter(shown) : [];
    if (buttons.length !== 1 || buttons[0].disabled || doc.querySelector('[role="dialog"]')) return;
    let interrupted = false, used = false, picked = false, done = false, dialog = null, timer;
    const touched = event => { if (event.isTrusted) interrupted = true; };
    const owns = () => !interrupted && location.href === route && frame.isConnected && frame.contentDocument === doc &&
      frameCardNode(card) === node && frameViewer(card) === frame && projectFrames(conversation).filter(next =>
        next.selected && next.token === card.token && next.frameId === card.frameId && next.message === card.message && next.path === card.path).length === 1;
    let settle;
    const state = { source: null, promise: new Promise(resolve => { settle = resolve; }) };
    // One bounded export attempt per mounted native card. An uncertain UI action
    // is never replayed by the transcript's periodic reader.
    frameExports.set(node, state);
    const finish = source => {
      if (done) return; done = true; clearTimeout(timer); observer.disconnect();
      for (const root of [document, doc]) {
        root.removeEventListener('click', download, true);
        root.removeEventListener('pointerdown', touched, true); root.removeEventListener('keydown', touched, true);
      }
      if (source && owns()) state.source = source;
      if (dialog?.isConnected && owns()) {
        const close = [...dialog.querySelectorAll('button[aria-label="Close"]')]; if (close.length === 1) close[0].click();
      }
      activeFrameReads.delete(cancel); settle();
    };
    const cancel = () => { interrupted = true; finish(null); };
    const download = event => {
      const anchor = event.target?.closest?.('a[download]');
      if (!picked || event.isTrusted || !owns() || !anchor || anchor.download.length > 256 || !/\.html$/i.test(anchor.download) || !/^blob:https:\/\/claude\.ai\/[0-9a-f-]{36}$/i.test(anchor.href)) return;
      // Retain only this native export. Its generated click must not open Save As
      // or write a duplicate file; ordinary user exports remain untouched.
      event.preventDefault(); if (used) return; used = true;
      void (async () => {
        let reader;
        try {
          const reply = await fetch(anchor.href, { signal: AbortSignal.timeout(2000) });
          // The native HTML exporter intentionally labels its download as an
          // octet stream. The selected HTML action and exact frame own its type;
          // retain only bounded UTF-8 HTML, never a generic download response.
          if (!reply.ok || !/^(?:text\/html|application\/octet-stream)(?:;|$)/i.test(reply.headers.get('content-type') || '') || !reply.body) return finish(null);
          reader = reply.body.getReader(); const chunks = []; let bytes = 0;
          for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.byteLength;
            if (bytes > 240000 || !owns()) return finish(null); chunks.push(next.value); }
          const buffer = new Uint8Array(bytes); let offset = 0;
          for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
          const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
          finish(text.length <= 240000 && /^\s*(?:<!doctype\s+html\b|<html(?:\s|>))/i.test(text) ? text : null);
        } catch { finish(null); } finally { try { await reader?.cancel(); } catch { /* Already closed. */ } }
      })();
    };
    const observer = new MutationObserver(() => {
      if (picked || used || !owns()) return;
      const dialogs = [...doc.querySelectorAll('[role="dialog"]')]; if (dialogs.length !== 1) return;
      const html = [...dialogs[0].querySelectorAll('button')].filter(button =>
        button.textContent.includes('HTML') && button.textContent.includes('Standalone web page') && !button.disabled);
      if (html.length !== 1) return;
      dialog = dialogs[0]; picked = true; html[0].click();
    });
    for (const root of [document, doc]) {
      root.addEventListener('click', download, true);
      root.addEventListener('pointerdown', touched, true); root.addEventListener('keydown', touched, true);
    }
    activeFrameReads.add(cancel); observer.observe(doc.documentElement, { childList: true, subtree: true });
    timer = setTimeout(() => finish(null), 2500);
    try { buttons[0].click(); } catch { finish(null); }
    await state.promise;
  }
  function project() {
    const match = new RegExp(`^/chat/(${UUID})/?$`, 'i').exec(location.pathname);
    if (location.origin !== 'https://claude.ai' || !match) return { cards: [], viewer: null };
    const conversation = match[1].toLowerCase(), cards = projectFrames(conversation), widgets = projectWidgets(conversation), diagrams = projectMermaids(conversation);
    for (const node of [...document.querySelectorAll('[data-testid="file-card-open"][data-cds="CardLink"][role="button"]')].slice(-32)) {
      if (!shown(node) || !node.closest('[data-testid="file-card-block"][data-file-row-card]')) continue;
      const message = node.closest('[data-testid="assistant-message"]'), native = suffix.exec(message?.id || '')?.[1]?.toLowerCase();
      if (!native || message.getAttribute('data-turn-key')?.toLowerCase() !== native) continue;
      const metadata = uniqueValue(propsAt(node).flatMap(props => {
        const file = fileOf(props), owner = own(props, 'conversationUuid'), response = own(props, 'messageUuid');
        return file && typeof owner === 'string' && owner.toLowerCase() === conversation && typeof response === 'string' && response.toLowerCase() === native
          ? [{ ...file, conversation, message: native }] : [];
      }));
      if (!metadata) continue;
      let token = node.getAttribute('data-clf-claude-file-token');
      if (!uuid.test(token || '')) { token = crypto.randomUUID(); node.setAttribute('data-clf-claude-file-token', token); }
      const label = node.getAttribute('aria-label') || '';
      cards.push({ ...metadata, token, selected: node.getAttribute('aria-current') === 'true',
        title: label.startsWith('View ') ? label.slice(5, 205) : metadata.name,
        streaming: message.getAttribute('data-is-streaming') !== 'false' });
    }
    const frames = cards.filter(card => card.frameId && card.selected && frameViewer(card));
    if (frames.length === 1) {
      const card = frames[0], source = frameExports.get(frameCardNode(card))?.source;
      if (source) return { cards, widgets, diagrams, viewer: { ...card, content: source, mimeType: 'text/html', language: 'html' } };
    }
    const content = [...document.querySelectorAll('[data-skill-file-viewer="true"] #wiggle-file-content')].filter(shown);
    if (content.length !== 1) return { cards, widgets, diagrams, viewer: null };
    const node = content[0], props = propsAt(node);
    const sources = uniqueValue(props.flatMap(value => {
      const body = own(value, 'content'), path = safePath(own(value, 'filePath')), mimeType = own(value, 'mimeType'), language = own(value, 'language'), name = own(value, 'fileName');
      return typeof body === 'string' && body.length <= 1024 * 1024 && path && typeof mimeType === 'string' && mimeType.length <= 128 &&
        typeof language === 'string' && language.length <= 40 && typeof name === 'string' && name.length > 0 && name.length <= 256
        ? [{ path, name, content: body, mimeType, language }] : [];
    }));
    if (!sources) return { cards, widgets, diagrams, viewer: null };
    const owner = uniqueValue(props.flatMap(value => {
      const file = fileOf(value), chat = own(value, 'conversationUuid'), messageId = own(value, 'messageId');
      if (!file || typeof chat !== 'string' || chat.toLowerCase() !== conversation || typeof messageId !== 'string') return [];
      // A literal UUID is already an exact identity. The witnessed new-message
      // UI prefix is the sole normalized wrapper; arbitrary suffixes are refused.
      const message = (messageId.startsWith('new-assistant-message-uuid-') ? messageId.slice('new-assistant-message-uuid-'.length) : messageId).toLowerCase();
      return uuid.test(message) ? [{ ...file, message, conversation }] : [];
    }));
    if (!owner || owner.path !== sources.path || owner.name !== sources.name) return { cards, widgets, diagrams, viewer: null };
    const selected = cards.filter(card => card.selected && card.path === owner.path && card.name === owner.name && card.message === owner.message);
    if (selected.length !== 1) return { cards, widgets, diagrams, viewer: null };
    return { cards, widgets, diagrams, viewer: { ...sources, ...owner, token: selected[0].token } };
  }
  const receive = event => {
    if (event.source !== window || event.origin !== location.origin || !['onecode-claude-file-read', 'onecode-claude-user-read'].includes(event.data?.type) ||
        !/^[0-9a-f-]{36}$/.test(event.data.nonce || '')) return;
    if (event.data.type === 'onecode-claude-user-read') {
      let user; try { user = projectUser(event.data.message); } catch { user = null; }
      window.postMessage({ type: 'onecode-claude-user-read-result', nonce: event.data.nonce, path: location.pathname, user }, location.origin);
      return;
    }
    const nonce = event.data.nonce, route = location.pathname;
    void captureSelectedFrame().catch(() => {}).then(() => {
      if (location.pathname !== route) return;
      let result; try { result = project(); } catch { result = { cards: [], viewer: null }; }
      window.postMessage({ type: 'onecode-claude-file-read-result', nonce, path: route, ...result }, location.origin);
    });
  };
  window.addEventListener('message', receive);
  globalThis.__ONECODE_CLAUDE_NATIVE__ = { version: VERSION, stop: () => { window.removeEventListener('message', receive); for (const cancel of [...activeFrameReads]) cancel(); } };
})();
