import { recoverySteps } from '../shared/tailscale-recovery.js';
import { el, run, toast } from './dom.js';
import { t } from './i18n.js';

/** Shared recovery UI: wraps commands to fit narrow settings panes. */
export function paintTailscaleRecovery(host: HTMLElement, step: string | undefined, mode: 'remote' | 'tunnel'): void {
  const signature = `${mode}:${step ?? 'failure'}`;
  if (host.dataset.recovery === signature) return;
  host.dataset.recovery = signature; host.replaceChildren();
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
      const copy = el('button', 'btn', () => t('Copy PowerShell command')) as HTMLButtonElement;
      copy.type = 'button'; copy.onclick = async () => { if (await run(window.api.writeClipboard(instruction.command!))) toast(t('Copied')); }; item.append(copy);
    }
    list.append(item);
  }
  details.append(list); host.append(details);
}
