import { recoverySteps } from '../shared/tailscale-recovery.js';
import { el, run, toast } from './dom.js';
import { t } from './i18n.js';

/** Shared recovery UI: wraps commands to fit narrow settings panes. */
export function paintTailscaleRecovery(host: HTMLElement, step: string | undefined, mode: 'remote' | 'tunnel', canRepair = false): void {
  const signature = `${mode}:${step ?? 'failure'}:${canRepair}`;
  if (host.dataset.recovery === signature) return;
  host.dataset.recovery = signature; host.replaceChildren();
  if (canRepair && mode === 'tunnel') {
    host.append(el('p', 'hint', () => t('Tailscale is connected locally, but its public TLS path failed. Repair restarts the system Tailscale service and briefly interrupts Tailscale connections. Windows may ask for administrator approval. Saved URLs and settings are retained.')));
    const repair = el('button', 'btn', () => t('Repair public connection')) as HTMLButtonElement;
    repair.type = 'button';
    repair.onclick = async () => {
      repair.disabled = true;
      try {
        if (await run(window.api.repairTailscale())) toast(t('Tailscale restarted. OneCode is checking the public connection.'));
      } catch { toast(t('The repair result is unknown. Check Tailscale before trying again.')); }
      finally { repair.disabled = false; }
    };
    host.append(repair);
  }
  const details = document.createElement('details'); details.className = 'tailscale-recovery';
  details.append(el('summary', '', () => t('Setup recovery steps')));
  const list = document.createElement('ol');
  for (const instruction of recoverySteps(step, mode)) {
    const item = document.createElement('li'); item.append(el('p', 'hint', () => t(instruction.text)));
    if (instruction.url) {
      const button = el('button', 'btn', () => t('Open setup page')) as HTMLButtonElement;
      button.type = 'button'; button.onclick = () => { void run(window.api.openLink(instruction.url!, { external: true })); }; item.append(button);
    }
    if (instruction.command) {
      const code = document.createElement('pre'); code.textContent = instruction.command; item.append(code);
      const copy = el('button', 'btn', () => t('Copy command')) as HTMLButtonElement;
      copy.type = 'button'; copy.onclick = async () => { if (await run(window.api.writeClipboard(instruction.command!))) toast(t('Copied')); }; item.append(copy);
    }
    list.append(item);
  }
  details.append(list); host.append(details);
}
