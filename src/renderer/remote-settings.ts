import { el, run, toast } from './dom.js';
import { t } from './i18n.js';
import type { RemoteStatus } from '../shared/remote.js';
import { TAILSCALE_SETUP_ACTIONS } from '../shared/tailscale-setup.js';
import { paintTailscaleRecovery } from './tailscale-recovery.js';

export function initRemoteSettings(): void {
  const enable = document.getElementById('remoteEnable') as HTMLInputElement;
  const address = document.getElementById('remoteAddress') as HTMLInputElement;
  let state: RemoteStatus | null = null, busy = false, generation = 0;
  const paint = (view: RemoteStatus) => {
    state = view; enable.checked = view.enabled;
    const setup = view.setup && TAILSCALE_SETUP_ACTIONS[view.setup.step];
    document.getElementById('remoteSetup')!.hidden = !setup;
    document.getElementById('remoteSetupAction')!.textContent = setup ? t(setup.label) : '';
    const recovery = document.getElementById('remoteRecovery')!; recovery.hidden = !view.error;
    if (view.error) paintTailscaleRecovery(recovery, view.setup?.step, 'remote');
    document.getElementById('remoteStatus')!.textContent = view.error ?? t(view.ready ? 'On' : view.enabled ? 'Connecting…' : 'Off');
    address.value = view.url ?? '';
    document.getElementById('remoteLinkConflict')!.hidden = !view.canRefreshLink;
    document.getElementById('remoteLink')!.hidden = !view.ready || !view.url;
    document.getElementById('remoteDevicesSection')!.hidden = !view.devices.length;
    const devices = document.getElementById('remoteDevices')!; devices.replaceChildren();
    for (const device of view.devices) { const row = el('div', 'setting'); row.append(el('span', '', device.name)); const revoke = el('button', 'btn', () => t('Revoke')) as HTMLButtonElement; revoke.type = 'button'; revoke.onclick = async () => { if (busy) return; const token = ++generation; const next = await run(window.api.remoteRevoke(device.id)); if (next && token === generation && enable.isConnected) paint(next); }; row.append(revoke); devices.append(row); }
  };
  const refresh = async () => { if (busy || !enable.isConnected) return; const token = ++generation;
    const view = await run(window.api.remoteStatus());
    if (view && token === generation && !busy && enable.isConnected) paint(view);
  };
  enable.onchange = async () => {
    if (busy) return; busy = true; generation++; enable.disabled = true;
    document.getElementById('remoteStatus')!.textContent = t(enable.checked ? 'Connecting…' : 'Turning off…');
    try { const view = await run(window.api.remoteEnabled(enable.checked)); if (!enable.isConnected) return; if (view) paint(view); else enable.checked = state?.enabled ?? false; }
    finally { busy = false; enable.disabled = false; }
  };
  document.getElementById('remoteRefresh')!.onclick = async () => {
    if (busy) return;
    busy = true; generation++; enable.disabled = true;
    const button = document.getElementById('remoteRefresh') as HTMLButtonElement; button.disabled = true;
    try {
      const view = state?.enabled && !state.ready ? await run(window.api.remoteEnabled(true)) : await run(window.api.remoteStatus());
      if (view && enable.isConnected) paint(view);
    } finally { busy = false; enable.disabled = false; button.disabled = false; }
  };
  document.getElementById('remoteSetupAction')!.onclick = () => { const action = state?.setup && TAILSCALE_SETUP_ACTIONS[state.setup.step]; if (action) void run(window.api.openLink(action.url, { external: true })); };
  document.getElementById('remoteRefreshLink')!.onclick = async () => {
    if (busy || !state?.canRefreshLink) return;
    busy = true; generation++; enable.disabled = true;
    const button = document.getElementById('remoteRefreshLink') as HTMLButtonElement; button.disabled = true;
    try { const view = await run(window.api.remoteRefreshLink()); if (view && enable.isConnected) { paint(view); if (view.ready) toast(t('Link refreshed. Copy the new link and update your bookmark.')); } }
    finally { busy = false; enable.disabled = false; button.disabled = false; }
  };
  document.getElementById('remoteCopyLink')!.onclick = async () => { if (state?.ready && state.url && await run(window.api.writeClipboard(state.url))) toast(t('Copied')); };
  document.querySelector<HTMLButtonElement>('[data-tab="remote"]')!.addEventListener('click', () => { void refresh(); });
  void refresh();
  const timer = window.setInterval(() => { if (state?.enabled && !state.ready && !document.hidden) void refresh(); }, 3_000);
  window.addEventListener('unload', () => window.clearInterval(timer), { once: true });
}
