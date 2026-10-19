import { shell } from 'electron';
import { TAILSCALE_SETUP_ACTIONS, type TailscaleSetupAction } from '../../shared/tailscale-setup.js';

const opened = new Set<string>();
/** Launch the required first-party setup once, then let the owner poll readiness. */
export async function requestTailscaleSetup(action: TailscaleSetupAction): Promise<void> {
  if (opened.has(action.step)) return;
  const destination = TAILSCALE_SETUP_ACTIONS[action.step];
  if (!destination) return;
  opened.add(action.step);
  try { await shell.openExternal(destination.url); }
  catch { opened.delete(action.step); /* The visible setup button and recovery guide remain available. */ }
}
