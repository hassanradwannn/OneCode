/** Lightweight rendering leases. The bridge/operation owns activity, never this module. */
export function createActiveTabs(chrome) {
  const KEY = 'cosActiveTabs';
  const scopes = new Map(), states = new Map(), retiring = new Set(), cancelled = new Map();
  // A Chrome mutation keeps its per-tab flight until its actual reply, even if
  // a caller stops waiting. Another tab never queues behind that unknown reply.
  const flights = new Map();
  const WAIT_MS = 1000;
  let saving = Promise.resolve();
  const valid = tab => Number.isInteger(tab?.id) && tab.id > 0 && typeof tab.url === 'string' &&
    tab.url.length <= 4096 && /^https:\/\/(?:gemini\.google\.com|chatgpt\.com|chat\.openai\.com|claude\.ai)\//.test(tab.url) && !tab.pendingUrl;
  const permitted = () => typeof chrome.permissions?.contains === 'function'
    ? chrome.permissions.contains({ permissions: ['debugger'] }).catch(() => false) : Promise.resolve(false);
  const save = () => {
    const work = saving.catch(() => undefined).then(() => chrome.storage.session.set({ [KEY]: [...states.values(), ...retiring]
      .filter(s => s.attached || s.failed).map(s => ({ id: s.id, url: s.url, attached: s.attached, failed: s.failed === true })) }));
    saving = work; return work;
  };
  async function bounded(work) {
    let timer;
    try { return await Promise.race([work, new Promise(resolve => { timer = setTimeout(resolve, WAIT_MS); })]); }
    finally { clearTimeout(timer); }
  }
  const loaded = (async () => {
    // Persisted attachment custody permits cleanup only. Fresh policy must earn a new lease.
    const stored = (await chrome.storage.session.get(KEY))[KEY];
    for (const tab of (Array.isArray(stored) ? stored : []).slice(0, 64)) {
      if (!valid(tab)) continue;
      if (tab.attached) retiring.add({ id: tab.id, url: tab.url, attached: true });
      if (tab.failed) cancelled.set(tab.id, tab.url);
    }
  })();
  async function detach(state) {
    state.rendered = false;
    if (!state.attached) return;
    // Revoking the browser permission ends this extension's debugger access.
    // Do not call an unavailable API or retain a usable rendering claim.
    if (!await permitted() || !chrome.debugger?.detach) { state.attached = false; return; }
    try { await chrome.debugger.detach({ tabId: state.id }); }
    catch {
      if (!state.attached) return;
      const targets = await chrome.debugger.getTargets();
      if (targets.some(t => t.tabId === state.id && t.attached)) throw new Error('Active tab release remains pending');
    }
    state.attached = false;
  }
  function current(state) {
    return states.get(state.id) === state && !state.cancelled && [...scopes.values()].some(scope =>
      scope.tabs.some(tab => tab.id === state.id && tab.url === state.url && (!scope.eligible || scope.eligible(tab) === true)));
  }
  async function attach(state) {
    if (cancelled.get(state.id) === state.url) state.failed = true;
    if (state.attached || state.failed || !current(state)) return;
    if (!await permitted() || !chrome.debugger?.attach || !current(state)) return;
    const tab = await chrome.tabs.get(state.id).catch(() => null);
    if (!current(state) || !valid(tab) || tab.url !== state.url) return;
    // A foreign debugger (including the browser tools) keeps its own session. Never steal it.
    state.attaching = true;
    try { await chrome.debugger.attach({ tabId: state.id }, '1.3'); }
    catch { state.failed = true; return; }
    finally { state.attaching = false; }
    state.attached = true;
    try {
      await save();
      const latest = await chrome.tabs.get(state.id);
      if (!await permitted() || !current(state) || state.failed || !state.attached || !valid(latest) || latest.url !== state.url) throw new Error('Tab changed');
      await chrome.debugger.sendCommand({ tabId: state.id }, 'Emulation.setFocusEmulationEnabled', { enabled: true });
      if (!current(state) || state.failed || !state.attached) throw new Error('Activity ended');
      state.rendered = true;
    } catch {
      state.failed = true;
      await detach(state);
    }
  }
  function syncTab(id) {
    const held = flights.get(id);
    if (held) { held.again = true; return held.work; }
    const flight = { again: false, work: null };
    flights.set(id, flight);
    flight.work = (async () => {
      do {
        flight.again = false;
        // A successor at this same id cannot attach until the original native
        // operation and its cleanup settle. Timing out a wait never refunds it.
        for (const state of retiring) if (state.id === id) {
          await detach(state); retiring.delete(state);
        }
        if (cancelled.has(id) && states.get(id)?.url !== cancelled.get(id)) cancelled.delete(id);
        const state = states.get(id);
        if (state) {
          if (!await permitted()) { state.rendered = false; if (state.attached) await detach(state); }
          // No DOM, Runtime, Network, screenshots, artificial input or polling domains.
          else await attach(state);
        }
        await save();
      } while (flight.again);
    })().finally(() => {
      if (flights.get(id) !== flight) return;
      flights.delete(id);
      // A projection may arrive between the final loop check and this cleanup.
      if (flight.again) void syncTab(id).catch(() => undefined);
    });
    // Work remains observed after a caller's bounded wait has ended.
    flight.work.catch(() => undefined);
    return flight.work;
  }
  function sync(waitIds = null) {
    return bounded((async () => {
      await loaded;
      for (const [id, url] of cancelled) if (states.get(id)?.url !== url) cancelled.delete(id);
      const ids = new Set([...states.keys(), ...[...retiring].map(state => state.id)]);
      const work = new Map([...ids].map(id => [id, syncTab(id)]));
      await Promise.all([...(waitIds || ids)].flatMap(id => work.has(id) ? [work.get(id)] : []));
      await save();
    })());
  }
  function project(waitIds = null) {
    const wanted = new Map();
    for (const scope of scopes.values()) for (const tab of scope.tabs)
      if (valid(tab) && (!scope.eligible || scope.eligible(tab) === true) && wanted.size < 64) wanted.set(tab.id, tab);
    for (const [id, state] of states) {
      if (wanted.get(id)?.url === state.url) continue;
      state.cancelled = true;
      states.delete(id);
      if (state.attached || state.attaching) retiring.add(state);
    }
    for (const [id, tab] of wanted) if (!states.has(id)) states.set(id, { id, url: tab.url, attached: false, failed: false });
    return sync(waitIds);
  }
  return {
    // These are projections of existing owners, not persisted activity or opening authority.
    set(scope, tabs, eligible = null) {
      const waitIds = new Set([...(scopes.get(scope)?.tabs || []).map(tab => tab.id), ...tabs.filter(valid).map(tab => tab.id)]);
      if (tabs.length) scopes.set(scope, { tabs: tabs.filter(valid).slice(0, 64), eligible });
      else scopes.delete(scope);
      return project(waitIds);
    },
    owns(id) { return states.has(id) || [...retiring].some(s => s.id === id); },
    ready(id, url) {
      const state = states.get(id);
      return Boolean(state && state.url === url && state.attached && state.rendered && !state.failed && !state.cancelled && current(state));
    },
    snapshot() { return [...states.values()].map(state => ({ id: state.id, attached: state.attached === true, failed: state.failed === true })); },
    revoke() { scopes.clear(); return project(); },
    navigation(id, tab = null) {
      if (!states.has(id) && ![...retiring].some(s => s.id === id)) return Promise.resolve();
      let retained = false;
      for (const scope of scopes.values()) {
        const keep = scope.tabs.some(previous => previous.id === id) && tab?.id === id && valid(tab) && scope.eligible?.(tab) === true;
        scope.tabs = scope.tabs.flatMap(previous => previous.id !== id ? [previous] : keep ? [tab] : []);
        retained ||= keep;
      }
      // SPA routing keeps the browser document. Its existing owner can approve
      // the new route without suspending rendering during native New Chat.
      // Full document loads pass no tab and always release the old lease.
      const state = states.get(id);
      if (retained && state) {
        if (cancelled.get(id) === state.url) cancelled.set(id, tab.url);
        state.url = tab.url;
      }
      return project();
    },
    detached({ tabId }) {
      // Our own release can notify before its promise settles. It belongs to the retired
      // attachment, never a freshly projected successor at the same tab id.
      const old = [...retiring].find(s => s.id === tabId && s.attached);
      if (old) { old.attached = false; old.rendered = false; return sync(new Set([tabId])); }
      // Chrome/user cancellation lasts until this activity scope ends. No attach loop.
      const state = states.get(tabId);
      if (!state) return Promise.resolve();
      state.attached = false; state.rendered = false; state.failed = true; cancelled.set(tabId, state.url);
      return sync(new Set([tabId]));
    }
  };
}
