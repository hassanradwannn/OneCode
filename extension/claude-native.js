/** Bounded read-only projection of the native rendered generated-file viewer.
 * Does not read requests, cookies, hidden analysis, React callbacks or provider APIs. */
(() => {
  'use strict';
  const VERSION = 4;
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
    const result = [], seen = new Set(); let fiber = own(node, keys[0]);
    for (let count = 0; fiber && count < 40 && !seen.has(fiber); count++) {
      seen.add(fiber); const props = own(fiber, 'memoizedProps');
      if (props && typeof props === 'object') result.push(props);
      fiber = own(fiber, 'return');
    }
    return result;
  }
  const uniqueValue = values => {
    const distinct = [...new Map(values.map(value => [JSON.stringify(value), value])).values()];
    return distinct.length === 1 ? distinct[0] : null;
  };
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
    if (bodies !== 1) { diagnostic('body-unavailable', { bodies }); return null; }
    const props = propsAt(node), sources = props.flatMap(props => {
      const row = own(props, 'row');
      const candidates = [own(props, 'turn'), own(row, 'kind') === 'turn' ? own(row, 'turn') : null];
      return candidates.flatMap(turn => {
        if (own(turn, 'id') !== message || own(turn, 'role') !== 'user') return [];
        const items = own(turn, 'items');
        if (!Array.isArray(items) || items.length !== 1) return [];
        const item = own(items, '0'), text = own(item, 'text');
        return own(item, 'kind') === 'text' && own(item, 'id') === `${message}:0` && own(item, 'format') === 'plain' &&
          typeof text === 'string' && text.length > 0 && text.length <= 240000 ? [{ text }] : [];
      });
    });
    const source = uniqueValue(sources);
    if (!source) { diagnostic('source-unavailable', { props: props.length, candidates: sources.length,
      fiberKeys: Object.getOwnPropertyNames(node).filter(key => key.startsWith('__reactFiber$')).length }); return null; }
    let token = node.getAttribute('data-clf-claude-user-token');
    if (!uuid.test(token || '')) { token = crypto.randomUUID(); node.setAttribute('data-clf-claude-user-token', token); }
    diagnostic('ready', { props: props.length, candidates: sources.length });
    return { conversation: chat, message, token, text: source.text };
  }
  function projectComposer() {
    if (location.origin !== 'https://claude.ai') return null;
    const boxes = [...document.querySelectorAll('[data-testid="chat-input"][data-cds="Editor"][contenteditable="true"][role="textbox"][aria-label="Write your prompt to Claude"]')].filter(shown);
    if (boxes.length !== 1) return null;
    const box = boxes[0], rows = [...document.querySelectorAll('[data-cds-composer-attachments] [data-testid="file-thumbnail"][data-cds-attachment]')].filter(shown);
    if (!rows.length || rows.length > 20) return null;
    const files = [], states = [];
    for (const row of rows) {
      const remove = [...row.querySelectorAll('button[data-cds-attachment-remove][aria-label^="Remove "]')];
      const name = remove.length === 1 ? remove[0].getAttribute('aria-label')?.slice('Remove '.length) : null;
      if (!name || name.length > 512) return null;
      const props = propsAt(row);
      const metadata = uniqueValue(props.flatMap(value => {
        const attachment = own(value, 'attachment'), nativeName = own(attachment, 'file_name'), type = own(attachment, 'file_type'), size = own(attachment, 'file_size');
        if (row.getAttribute('data-cds') === 'MessageAttachmentsFile') return nativeName === name && typeof type === 'string' && type.length <= 128 && Number.isSafeInteger(size) && size >= 0
          ? [{ name, type, size, kind: 'file', ready: true }] : [];
        if (row.getAttribute('data-cds') !== 'MessageAttachmentsImage') return [];
        const file = own(value, 'file'), fileName = own(file, 'file_name'), fileSize = own(file, 'size_bytes'), pending = own(value, 'pending'), success = own(file, 'success');
        // The image variant supplies primitive upload proof on file, not a text
        // attachment. Never inspect its nativeFile, URL, user IDs or bytes.
        return fileName === name && own(file, 'file_kind') === 'image' && Number.isSafeInteger(fileSize) && fileSize >= 0 &&
          typeof success === 'boolean' && typeof pending === 'boolean' ? [{ name, size: fileSize, kind: 'image', ready: success && !pending }] : [];
      }));
      if (!metadata) return null;
      const ready = uniqueValue(props.flatMap(value => {
        const file = own(value, 'isUploadingFile'), sync = own(value, 'isUploadingSync'), count = own(value, 'attachmentPlaceholderCount');
        return own(value, 'inComposer') === true && own(value, 'inCdsComposer') === true && typeof file === 'boolean' &&
          typeof sync === 'boolean' && Number.isSafeInteger(count) && count >= 0 && count <= 20 ? [{ file, sync, count }] : [];
      }));
      if (!ready) return null;
      let token = row.getAttribute('data-clf-claude-attachment-token');
      if (!uuid.test(token || '')) { token = crypto.randomUUID(); row.setAttribute('data-clf-claude-attachment-token', token); }
      files.push({ ...metadata, token }); states.push(ready);
    }
    const state = uniqueValue(states); if (!state) return null;
    let token = box.getAttribute('data-clf-claude-composer-token');
    if (!uuid.test(token || '')) { token = crypto.randomUUID(); box.setAttribute('data-clf-claude-composer-token', token); }
    return { token, files, uploadingFile: state.file, uploadingSync: state.sync, placeholderCount: state.count };
  }
  function project() {
    const match = new RegExp(`^/chat/(${UUID})/?$`, 'i').exec(location.pathname);
    if (location.origin !== 'https://claude.ai' || !match) return { cards: [], viewer: null };
    const conversation = match[1].toLowerCase(), cards = [];
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
    const content = [...document.querySelectorAll('[data-skill-file-viewer="true"] #wiggle-file-content')].filter(shown);
    if (content.length !== 1) return { cards, viewer: null };
    const node = content[0], props = propsAt(node);
    const sources = uniqueValue(props.flatMap(value => {
      const body = own(value, 'content'), path = safePath(own(value, 'filePath')), mimeType = own(value, 'mimeType'), language = own(value, 'language'), name = own(value, 'fileName');
      return typeof body === 'string' && body.length <= 1024 * 1024 && path && typeof mimeType === 'string' && mimeType.length <= 128 &&
        typeof language === 'string' && language.length <= 40 && typeof name === 'string' && name.length > 0 && name.length <= 256
        ? [{ path, name, content: body, mimeType, language }] : [];
    }));
    if (!sources) return { cards, viewer: null };
    const owner = uniqueValue(props.flatMap(value => {
      const file = fileOf(value), chat = own(value, 'conversationUuid'), messageId = own(value, 'messageId');
      if (!file || typeof chat !== 'string' || chat.toLowerCase() !== conversation || typeof messageId !== 'string') return [];
      // A literal UUID is already an exact identity. The witnessed new-message
      // UI prefix is the sole normalized wrapper; arbitrary suffixes are refused.
      const message = (messageId.startsWith('new-assistant-message-uuid-') ? messageId.slice('new-assistant-message-uuid-'.length) : messageId).toLowerCase();
      return uuid.test(message) ? [{ ...file, message, conversation }] : [];
    }));
    if (!owner || owner.path !== sources.path || owner.name !== sources.name) return { cards, viewer: null };
    const selected = cards.filter(card => card.selected && card.path === owner.path && card.name === owner.name && card.message === owner.message);
    if (selected.length !== 1) return { cards, viewer: null };
    return { cards, viewer: { ...sources, ...owner, token: selected[0].token } };
  }
  const receive = event => {
    if (event.source !== window || event.origin !== location.origin || !['onecode-claude-file-read', 'onecode-claude-composer-read', 'onecode-claude-user-read'].includes(event.data?.type) ||
        !/^[0-9a-f-]{36}$/.test(event.data.nonce || '')) return;
    if (event.data.type === 'onecode-claude-user-read') {
      let user; try { user = projectUser(event.data.message); } catch { user = null; }
      window.postMessage({ type: 'onecode-claude-user-read-result', nonce: event.data.nonce, path: location.pathname, user }, location.origin);
      return;
    }
    if (event.data.type === 'onecode-claude-composer-read') {
      let composer; try { composer = projectComposer(); } catch { composer = null; }
      window.postMessage({ type: 'onecode-claude-composer-read-result', nonce: event.data.nonce, path: location.pathname, composer }, location.origin);
      return;
    }
    let result; try { result = project(); } catch { result = { cards: [], viewer: null }; }
    window.postMessage({ type: 'onecode-claude-file-read-result', nonce: event.data.nonce, path: location.pathname, ...result }, location.origin);
  };
  window.addEventListener('message', receive);
  globalThis.__ONECODE_CLAUDE_NATIVE__ = { version: VERSION, stop: () => window.removeEventListener('message', receive) };
})();
