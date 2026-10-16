/** Account indexes are observed URL presentation, never account/session authority. */
export function createGeminiRouting(chrome, ownedWindow) {
  const KEY = 'geminiConversationPaths';
  const paths = new Map();
  const parse = value => {
    try {
      const url = new URL(value);
      if (url.origin !== 'https://gemini.google.com') return null;
      const match = /^(\/u\/\d+)?\/app(?:\/([0-9a-f]{16}))?\/?$/i.exec(url.pathname);
      return match ? { url, prefix: match[1] || '', conversation: match[2]?.toLowerCase() || null,
        path: `${match[1] || ''}/app${match[2] ? '/' + match[2].toLowerCase() : ''}` } : null;
    } catch { return null; }
  };
  // A selected native setup page establishes only which account New chat
  // should open. It cannot identify/revive a conversation or be reused as one.
  const selectedContext = value => {
    const app = parse(value);
    if (app) return app;
    try {
      const url = new URL(value);
      if (url.origin !== 'https://gemini.google.com') return null;
      const match = /^(\/u\/\d+)?\/customize\/(?:connectors|skills)\/?$/i.exec(url.pathname);
      return match ? { prefix: match[1] || '', conversation: null } : null;
    } catch { return null; }
  };
  const loaded = (async () => {
    const saved = (await chrome.storage.local.get(KEY))[KEY];
    for (const [id, path] of Object.entries(saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {}).slice(-1000)) {
      if (/^[0-9a-f]{16}$/.test(id) && path === null) { paths.set(id, null); continue; }
      const route = typeof path === 'string' && parse(`https://gemini.google.com${path}`);
      if (/^[0-9a-f]{16}$/.test(id) && route?.conversation === id && route.path === path) paths.set(id, path);
    }
  })();
  let writing = Promise.resolve();
  async function observe(tabs) {
    await loaded;
    let changed = false;
    const observed = new Map();
    for (const tab of tabs) {
      if (tab?.incognito || tab?.pendingUrl) continue;
      const route = parse(tab?.url);
      if (!route?.conversation) continue;
      const alternatives = observed.get(route.conversation) || new Set();
      alternatives.add(route.path); observed.set(route.conversation, alternatives);
    }
    for (const [id, alternatives] of observed) {
      const path = alternatives.size === 1 ? [...alternatives][0] : null;
      if (paths.has(id) && paths.get(id) === path) continue;
      paths.delete(id); paths.set(id, path); changed = true;
    }
    while (paths.size > 1000) paths.delete(paths.keys().next().value);
    if (!changed) return;
    const write = writing.then(() => chrome.storage.local.set({ [KEY]: Object.fromEntries(paths) }));
    writing = write.catch(() => undefined);
    await write;
  }
  async function resolve(value, { sourceConversationId = null, sourceTabId = null } = {}) {
    const requested = parse(value);
    if (!requested) return value;
    const tabs = await chrome.tabs.query({ url: ['https://gemini.google.com/*'] });
    await observe(tabs);
    if (requested.prefix) return requested.url.href;
    const sourceId = typeof sourceConversationId === 'string' && /^[0-9a-f]{16}$/i.test(sourceConversationId)
      ? sourceConversationId.toLowerCase() : null;
    const wanted = requested.conversation || sourceId;
    let context = null;
    if (Number.isInteger(sourceTabId)) {
      const tab = await chrome.tabs.get(sourceTabId).catch(() => null);
      const observed = !tab?.pendingUrl && !tab?.incognito && parse(tab?.url);
      if (!observed || (sourceId && observed.conversation !== sourceId)) throw new Error('gemini_source_account_changed');
      context = observed;
    }
    if (!context && wanted) {
      const observed = tabs.filter(tab => !tab.incognito && !tab.pendingUrl).map(tab => parse(tab.url)).filter(route => route?.conversation === wanted);
      const alternatives = new Set(observed.map(route => route.prefix));
      if (alternatives.size > 1 || (!observed.length && paths.has(wanted) && paths.get(wanted) === null))
        throw new Error('gemini_conversation_account_ambiguous');
      context = observed[0] || (paths.has(wanted) ? parse(`https://gemini.google.com${paths.get(wanted)}`) : null);
      if (!context) throw new Error('gemini_conversation_account_unknown');
    }
    if (!context) {
      const managed = await ownedWindow().catch(() => null);
      let selected = tabs.filter(tab => tab.active === true && tab.windowId === managed?.id && !tab.pendingUrl && !tab.incognito);
      if (selected.length !== 1 || !selectedContext(selected[0].url)) {
        const browserWindow = await chrome.windows.getLastFocused().catch(() => null);
        selected = tabs.filter(tab => tab.active === true && tab.windowId === browserWindow?.id && !tab.pendingUrl && !tab.incognito);
      }
      if (selected.length !== 1) throw new Error('gemini_account_context_required');
      const current = await chrome.tabs.get(selected[0].id).catch(() => null);
      if (!current || current.pendingUrl || current.url !== selected[0].url || current.windowId !== selected[0].windowId || current.active !== true || current.incognito)
        throw new Error('gemini_selected_account_changed');
      context = selectedContext(current.url);
      if (!context) throw new Error('gemini_account_context_required');
    }
    requested.url.pathname = `${context.prefix}/app${requested.conversation ? '/' + requested.conversation : ''}`;
    return requested.url.href;
  }
  const sameAccount = (left, right) => {
    const a = parse(left), b = parse(right);
    return Boolean(a && b && a.prefix === b.prefix);
  };
  return { observe, resolve, sameAccount };
}
