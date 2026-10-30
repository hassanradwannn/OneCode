/** Native account choices only. Visible labels are opaque UI identities, not
 * invented Anthropic execution slugs. Every change is confirmed by checked rows. */
var CLF_CLAUDE_MODELS = (() => {
  const OWN = '[data-clf-root],.clf-stream,.clf-stage,.clf-composer,.clf-boot,[data-clf-user-text]';
  const compact = value => String(value || '').replace(/\s+/g, ' ').trim();
  const modelIdentity = value => compact(value).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}.]/gu, '');
  const shown = node => Boolean(node?.isConnected && !node.closest(`${OWN},[hidden],[aria-hidden="true"],[inert]`) &&
    node.getClientRects().length && getComputedStyle(node).display !== 'none' && getComputedStyle(node).visibility !== 'hidden');
  const enabled = node => shown(node) && !node.disabled && node.getAttribute('aria-disabled') !== 'true';
  const unique = values => { const nodes = [...new Set(values)].filter(shown); return nodes.length === 1 ? nodes[0] : null; };
  const DECORATIVE = 'svg,[data-cds="Icon"],[hidden],[aria-hidden="true"],[inert]';
  const text = node => {
    if (!node || node.matches?.(DECORATIVE)) return '';
    const copy = node.cloneNode(true); for (const icon of copy.querySelectorAll(DECORATIVE)) icon.remove();
    return compact(copy.textContent);
  };
  function leadingName(row) {
    let budget = 128;
    const read = (node, depth) => {
      if (!node || depth > 12 || --budget < 0) return '';
      if (node.nodeType === Node.TEXT_NODE) return compact(node.textContent);
      if (node.nodeType !== Node.ELEMENT_NODE || node.matches(DECORATIVE)) return '';
      for (const child of node.childNodes) { const name = read(child, depth + 1); if (name) return name; }
      // An icon-only wrapper is empty. Falling back to its textContent would
      // resurrect the font glyph and make selected model IDs change on check.
      return '';
    };
    return read(row, 0);
  }
  const button = () => unique(document.querySelectorAll('button[aria-label^="Model:"]'));
  function ownedMenu(trigger, parent = null) {
    if (!trigger?.isConnected) return null;
    const ids = compact(trigger.getAttribute('aria-controls')).split(' ').filter(Boolean);
    if (ids.length > 4) return null;
    const controlled = ids.map(id => document.getElementById(id)).filter(node => node?.matches('[role="menu"]') && shown(node));
    if (controlled.length) return unique(controlled);
    const menus = [...document.querySelectorAll('[role="menu"]')].filter(shown);
    if (trigger.id) {
      const labelled = menus.filter(node => compact(node.getAttribute('aria-labelledby')).split(' ').includes(trigger.id));
      if (labelled.length) return unique(labelled);
    }
    // Native Radix portals can be linked only while expanded. A unique menu
    // opened by this exact control is sufficient for UI navigation, not caller proof.
    return trigger.getAttribute('aria-expanded') === 'true' ? unique(menus.filter(node => node !== parent && !node.contains(parent))) : null;
  }
  function rows(scope) {
    if (!scope) return [];
    const menu = scope.matches('[role="menu"]') ? scope : scope.closest('[role="menu"]');
    return [...scope.querySelectorAll('[role="menuitemradio"]')].filter(row => row.closest('[role="menu"]') === menu && enabled(row) &&
      // Entitlement follows rendered text, including visually present badges
      // omitted from accessibility. Semantic icon stripping is for names only.
      !/\bupgrade\b/i.test(compact(row.innerText ?? row.textContent))).map(node => ({ node, id: leadingName(node), label: leadingName(node),
      selected: node.getAttribute('aria-checked') === 'true', description: text(node).slice(leadingName(node).length).trim().slice(0, 320) }))
      .filter(row => row.id && row.id.length <= 80 && !/[\u0000-\u001f\u007f]/.test(row.id));
  }
  function labelledGroup(menu, name) {
    if (!menu) return null;
    return unique([...menu.querySelectorAll('[role="group"][aria-labelledby]')].filter(group => {
      if (group.closest('[role="menu"]') !== menu) return false;
      const ids = compact(group.getAttribute('aria-labelledby')).split(' ').filter(Boolean);
      if (ids.length !== 1) return false;
      const label = document.getElementById(ids[0]);
      // ARIA references intentionally name an inline group with a hidden label.
      // Read only this exact label; do not bypass visibility for its controls.
      return label && !label.closest(OWN) && compact(label.textContent) === name;
    }));
  }
  function modelRows(scope) {
    if (!scope) return [];
    const menu = scope.matches('[role="menu"]') ? scope : scope.closest('[role="menu"]');
    const thinking = labelledGroup(menu, 'Effort'), legacy = labelledGroup(menu, 'More models');
    return rows(scope).filter(row => !thinking?.contains(row.node) && (scope !== menu || !legacy?.contains(row.node)));
  }
  const effortId = label => ({ low: 'low', medium: 'medium', high: 'high', extra: 'xhigh', max: 'max' })[compact(label).toLowerCase()] || null;
  const wait = (read, current, timeout = 3500) => new Promise(resolve => {
    let done = false, scheduled = null;
    const finish = value => { if (done) return; done = true; observer.disconnect(); clearTimeout(timer); if (scheduled !== null) clearTimeout(scheduled); resolve(value); };
    const check = () => { if (!current()) return finish(null); try { const value = read(); if (value) finish(value); } catch { finish(null); } };
    const observer = new MutationObserver(() => { if (scheduled === null) scheduled = setTimeout(() => { scheduled = null; check(); }, 0); });
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    const timer = setTimeout(() => finish(null), timeout); check();
  });
  const key = (node, value) => { if (!node?.isConnected) return false; node.focus(); node.dispatchEvent(new KeyboardEvent('keydown', { key: value, code: value, bubbles: true, cancelable: true })); return true; };
  function create(lease) {
    let latest = null;
    let failureCode = null;
    const closeDiagnostics = [];
    const closing = (stage, menu, trigger, closed = null) => {
      closeDiagnostics.push({ stage, at: Date.now(), current: lease.current(), closed,
        triggerExpanded: trigger?.getAttribute('aria-expanded') === 'true', connected: menu?.isConnected === true,
        shown: shown(menu), dataOpen: menu?.hasAttribute('data-open') === true, dataClosed: menu?.hasAttribute('data-closed') === true });
      if (closeDiagnostics.length > 8) closeDiagnostics.shift();
      try { document.documentElement.setAttribute('data-onecode-claude-picker-diagnostic', JSON.stringify(closeDiagnostics)); } catch { /* Read-only diagnostic flags. */ }
    };
    let powerScope = null;
    const observedPowers = new Map();
    const current = () => lease.current();
    function powerCache() {
      const account = document.querySelector('button[data-testid="user-menu-button"]'), selector = button(), route = location.pathname;
      if (!powerScope || powerScope.account !== account || powerScope.selector !== selector || powerScope.route !== route) {
        observedPowers.clear(); powerScope = { account, selector, route };
      }
      return observedPowers;
    }
    // A human native-page interaction invalidates retained capability metadata.
    // This cache never survives account/document changes or authorizes a Send.
    const invalidate = event => { if (event.isTrusted) { observedPowers.clear(); powerScope = null; } };
    document.addEventListener('pointerdown', invalidate, true); document.addEventListener('keydown', invalidate, true);
    const root = () => ownedMenu(button());
    const open = async () => {
      if (!current()) return null;
      const trigger = button(); if (!enabled(trigger)) return null;
      if (!root()) trigger.click();
      return wait(() => { const menu = root(); return menu && (modelRows(menu).length || rows(labelledGroup(menu, 'More models')).length) ? menu : null; }, current);
    };
    const submenuTrigger = (menu, name) => unique([...(menu?.querySelectorAll('[role="menuitem"]') || [])]
      .filter(node => node.closest('[role="menu"]') === menu && enabled(node) &&
        (leadingName(node) === name || name === 'Effort' && /^Effort (?:Low|Medium|High|Extra|Max|Extended|Off)$/.test(leadingName(node)))));
    const sub = async (menu, name) => {
      const trigger = submenuTrigger(menu, name); if (!trigger || !current()) return null;
      let panel = ownedMenu(trigger, menu);
      if (!panel) trigger.click();
      panel = await wait(() => {
        const next = ownedMenu(trigger, menu);
        return next && next.querySelector('[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"]') ? next : null;
      }, current);
      return panel ? { trigger, panel, name } : null;
    };
    const closeMenu = async (menu, stage = 'closingLegacy', trigger = null) => {
      if (!shown(menu)) return true;
      closing(stage, menu, trigger);
      if (!current() || !key(menu, 'Escape')) return false;
      const closed = Boolean(await wait(() => !shown(menu), current));
      closing(stage, menu, trigger, closed); if (!closed) failureCode = 'picker_close_failed';
      return closed;
    };
    const close = async () => {
      for (let count = 0; count < 4; count++) {
        const menu = root(); if (!menu) return true;
        // Escape from the actual menu focus scope, never an unrelated page control.
        const active = document.activeElement;
        closing('closingRoot', menu, button());
        if (!current() || !key(menu.contains(active) ? active : menu, 'Escape')) return false;
        const closed = Boolean(await wait(() => !root(), current));
        closing('closingRoot', menu, button(), closed);
        if (closed) return true;
      }
      failureCode = 'picker_close_failed';
      return false;
    };
    const catalog = async () => {
      const menu = await open(); if (!menu) return null;
      const primary = modelRows(menu).map(row => ({ ...row, group: undefined }));
      let legacy = [];
      const inlineLegacy = labelledGroup(menu, 'More models');
      const legacyTrigger = submenuTrigger(menu, 'More models');
      if (inlineLegacy) legacy = modelRows(inlineLegacy).map(row => ({ ...row, group: 'More models' }));
      else if (legacyTrigger) {
        const nested = await sub(menu, 'More models'); if (!nested) return null;
        legacy = modelRows(nested.panel).map(row => ({ ...row, group: leadingName(legacyTrigger) }));
        if (!await closeMenu(nested.panel, 'closingLegacy', nested.trigger)) return null;
      }
      const choices = [...primary, ...legacy];
      return choices.length && choices.length <= 64 && new Set(choices.map(row => row.id)).size === choices.length ? choices : null;
    };
    const locate = async choice => {
      const menu = await open(); if (!menu) return null;
      const panel = choice.group ? labelledGroup(menu, choice.group) || (await sub(menu, choice.group))?.panel : menu;
      const matches = modelRows(panel).filter(row => row.id === choice.id);
      return matches.length === 1 ? matches[0] : null;
    };
    const proveModel = async choice => {
      const row = await locate(choice);
      if (!row) return false;
      const owner = row.node.closest('[role="menu"]'), inline = choice.group && labelledGroup(owner, choice.group);
      const panel = inline || owner;
      // Menu opening and selected-state hydration are distinct native renders.
      // Wait for this owned panel's exact checked row instead of accepting its
      // previous caption or failing on the first unhydrated radio sample.
      if (!await wait(() => modelRows(panel).some(current => current.id === choice.id && current.selected), current)) return false;
      if (choice.group && !inline && !await closeMenu(panel)) return false;
      return current();
    };
    const model = async choice => {
      const row = await locate(choice); if (!row || !current()) return false;
      if (!row.selected) {
        row.node.click();
        if (!await wait(() => !row.node.isConnected || !shown(row.node) || row.node.getAttribute('aria-checked') === 'true', current)) return false;
      }
      return proveModel(choice);
    };
    function reasoningOptions(scope) {
      if (!scope) return null;
      const levels = rows(scope);
      const menu = scope.matches('[role="menu"]') ? scope : scope.closest('[role="menu"]');
      const toggles = [...scope.querySelectorAll('[role="menuitemcheckbox"]')].filter(node => node.closest('[role="menu"]') === menu && shown(node));
      if (levels.length) {
        if (toggles.length) return null;
        const options = levels.map(row => ({ ...row, effort: effortId(row.label) }));
        if (!options.every(row => row.effort) || new Set(options.map(row => row.effort)).size !== options.length || options.filter(row => row.selected).length !== 1) return null;
        options.control = { kind: 'levels', label: 'Effort' }; return options;
      }
      if (toggles.length !== 1 || !enabled(toggles[0]) || leadingName(toggles[0]) !== 'Extended') return null;
      const node = toggles[0], state = node.getAttribute('aria-checked');
      if (state !== 'true' && state !== 'false') return null;
      const checked = state === 'true', description = text(node).slice('Extended'.length).trim().slice(0, 320);
      const options = [{ node, effort: 'none', label: 'Off', selected: !checked, description: '' },
        { node, effort: 'high', label: 'Extended', selected: checked, description }];
      options.control = { kind: 'toggle', label: 'Extended', on: 'high', off: 'none', checked };
      return options;
    }
    const reasoningScope = async menu => {
      const inline = labelledGroup(menu, 'Effort'); if (inline) return { panel: inline, inline: true };
      if (!submenuTrigger(menu, 'Effort')) return { panel: null, inline: true };
      return await sub(menu, 'Effort');
    };
    const efforts = async () => {
      const menu = await open(); if (!menu) return null;
      const scope = await reasoningScope(menu); if (!scope) return null;
      if (!scope.panel) return [];
      const options = reasoningOptions(scope.panel);
      if (!scope.inline && !await closeMenu(scope.panel, 'closingEffort', scope.trigger)) return null;
      return options;
    };
    const effort = async wanted => {
      if (!wanted) return true;
      const menu = await open(); if (!menu) return false;
      const scope = await reasoningScope(menu); if (!scope?.panel) return false;
      const options = reasoningOptions(scope.panel), matches = options?.filter(row => row.effort === wanted);
      if (matches?.length !== 1 || !current()) return false;
      if (!matches[0].selected) matches[0].node.click();
      if (!scope.inline && shown(scope.panel)) await closeMenu(scope.panel, 'closingEffort', scope.trigger);
      const observed = await efforts();
      return Boolean(observed?.some(row => row.effort === wanted && row.selected));
    };
    async function inspect(requestedModel = null) {
      failureCode = null; closeDiagnostics.length = 0;
      let original = null, originalEffort = null, complete = false;
      try {
        const choices = await catalog(); if (!choices) return null;
        const selected = choices.filter(row => row.selected); if (selected.length !== 1) return null;
        original = selected[0];
        if (requestedModel && original.id !== requestedModel) return null;
        const originalPowers = await efforts();
        originalEffort = originalPowers?.find(row => row.selected)?.effort || null;
        const cache = powerCache();
        if (originalPowers) {
          const saved = originalPowers.map(row => ({ effort: row.effort, label: row.label, description: row.description }));
          if (originalPowers.control) saved.control = { ...originalPowers.control };
          cache.set(original.id, saved);
        }
        else cache.delete(original.id);
        // Refresh is an observation, never a tour through every execution model.
        // Per-model levels remain unknown until that model is actually observed.
        const result = choices.map(choice => {
          const powers = cache.get(choice.id) || [];
          return { id: choice.id, label: choice.label, efforts: powers.map(row => row.effort), effortsObserved: cache.has(choice.id),
            ...(powers.control ? { reasoningControl: { ...powers.control } } : {}),
            ...(choice.description ? { description: choice.description } : {}), ...(choice.group ? { group: choice.group } : {}),
            ...(powers.length ? { effortLabels: Object.fromEntries(powers.map(row => [row.effort, row.label])),
              effortHints: Object.fromEntries(powers.filter(row => row.description).map(row => [row.effort, row.description])) } : {}) };
        });
        complete = current();
        return result;
      } finally {
        const closed = await close();
        if (!complete || !closed || !original) return null;
        failureCode = null;
        latest = { model: original.id, reasoningEffort: originalEffort, route: location.pathname, caption: button()?.getAttribute('aria-label') };
      }
    }
    async function prepare(wantedModel, failure = () => {}) {
      if (typeof wantedModel !== 'string' || !wantedModel) return false;
      let success = false;
      try {
        const choices = await catalog(), matches = choices?.filter(choice => choice.id === wantedModel);
        if (matches?.length !== 1 || !await model(matches[0])) { failure?.('model_unconfirmed'); return false; }
        latest = { model: matches[0].id, route: location.pathname, caption: button()?.getAttribute('aria-label') };
        success = current();
      } finally { if (!await close()) success = false; }
      return success;
    }
    async function select(wantedModel, wantedEffort, failure = () => {}, wantedLabel = undefined) {
      const refuse = reason => { failure?.(reason); return false; };
      let success = false, original = null, originalEffort = null;
      try {
        const choices = await catalog(); if (!choices) return refuse('picker-unavailable');
        const prior = choices.filter(row => row.selected);
        if (prior.length !== 1) return refuse('selection-unconfirmed');
        original = prior[0];
        const priorPowers = wantedEffort ? await efforts() : null;
        originalEffort = priorPowers?.find(row => row.selected)?.effort || null;
        const exact = wantedModel ? choices.filter(row => row.id === wantedModel) : [];
        const labelIdentity = modelIdentity(wantedLabel || wantedModel);
        const byLabel = wantedModel && !exact.length && labelIdentity ? choices.filter(row => modelIdentity(row.label) === labelIdentity) : [];
        const matches = wantedModel ? exact.length ? exact : byLabel : choices.filter(row => row.selected);
        if (matches.length !== 1 || !await model(matches[0])) return refuse('model-unconfirmed');
        if (!await effort(wantedEffort)) return refuse('effort-unconfirmed');
        if (!await proveModel(matches[0])) return refuse('model-unconfirmed');
        const powers = wantedEffort ? await efforts() : null;
        if (wantedEffort && !powers?.some(row => row.effort === wantedEffort && row.selected)) return refuse('effort-unconfirmed');
        latest = { model: matches[0].id, reasoningEffort: powers?.find(row => row.selected)?.effort || undefined, route: location.pathname, caption: button()?.getAttribute('aria-label') };
        success = current();
      } finally {
        if (!success && original && current()) { await model(original); await effort(originalEffort); }
        if (!await close()) success = false;
      }
      return success;
    }
    return { inspect, prepare, select, failureCode: () => failureCode, readable: () => Boolean(button()), currentSelection: () => latest?.route === location.pathname && latest.caption && button()?.getAttribute('aria-label') === latest.caption
      ? { model: latest.model, ...(latest.reasoningEffort ? { reasoningEffort: latest.reasoningEffort } : {}) } : null };
  }
  return { create, button };
})();
