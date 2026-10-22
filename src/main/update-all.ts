/** One explicit command over the existing updater, connection and refresh owners. */
import { checkForUpdates, configureUpdateInstall, localBetaUpdatesEnabled, manualDownloadUrl, requestBetaUpdateInstall, requestUpdateInstall, updateStatus } from './update.js';
import { consumeRequestedPluginRefreshStartup, requestPluginRefreshes } from './plugin-refresh.js';
import { startBridge } from './bridge.js';
import { connect, getStatus } from './connection.js';
import { getConfig } from './config.js';
import { wakeBrowserWork } from './browser-wake.js';
import type { UpdateAllResult } from '../shared/types.js';

let pass: Promise<UpdateAllResult> | null = null;
export function updateAll(quit: () => void, openDownload: (url: string) => Promise<void>, confirmRestart: (version: string) => Promise<boolean>): Promise<UpdateAllResult> {
  if (pass) return pass;
  const run = (async (): Promise<UpdateAllResult> => {
    await checkForUpdates();
    const update = updateStatus();
    const failed = update.stage === 'failed';
    const betaRevision = localBetaUpdatesEnabled() && update.stage === 'ready' ? update.latestRevision : null;
    // Ask after the download, when quitting can actually install the named build. A
    // cancelled dialog grants neither installer shutdown nor future startup work.
    if (update.stage === 'ready' && !await confirmRestart(betaRevision ? `Beta ${betaRevision.slice(0, 12)}` : update.latest!)) return 'cancelled';
    if (betaRevision) {
      configureUpdateInstall(quit);
      return requestBetaUpdateInstall(betaRevision);
    }
    // An app update must not wait on tunnel authentication or connectivity. The next
    // build connects for its accepted refresh request; the current build only commits intent.
    if (failed || !update.latest) {
      await startBridge();
      await connect();
    }
    // Durable before quitting: the next build can finish the requested connector work even
    // when automatic refresh/auto-connect are off. Neither preference is changed.
    const tunnel = getConfig().tunnel;
    const surfaces = getStatus().surfaces.filter(surface => surface.id === 'core' || (surface.available && surface.tools.length > 0 &&
      (tunnel.kind !== 'openai' || (surface.id === 'desktop' ? tunnel.desktopTunnelId : tunnel.pluginsTunnelId)))).map(surface => surface.id);
    // Core remains requested even if connecting failed before any surface became live.
    await requestPluginRefreshes(failed ? update.current : update.latest ?? update.current, [...new Set(['core' as const, ...surfaces])]);
    if (failed) {
      // GitHub failure does not block the running build's connector check. Keep the
      // release owner's failure and the operation error visible; this is no full pass.
      wakeBrowserWork();
      throw new Error(update.error ?? 'Update check failed');
    }
    if (update.stage === 'ready') {
      configureUpdateInstall(quit);
      return requestUpdateInstall(update.latest!);
    }
    if (update.latest) {
      await openDownload(manualDownloadUrl(update.latest));
      return 'manual';
    }
    wakeBrowserWork(); // Also lets the existing extension owner discover its shipped build.
    return 'checking-connectors';
  })().finally(() => { if (pass === run) pass = null; });
  pass = run;
  return run;
}

/** One durable startup attempt per accepted connector request; never another install. */
export async function resumeUpdateRefresh(): Promise<void> {
  // The config owner retains this incarnation through unrelated settings saves.
  // Actual tunnel edits (including A -> B -> A) cannot borrow its startup reservation.
  const tunnel = getConfig().tunnel, snapshot = JSON.stringify(tunnel);
  const current = () => getConfig().tunnel === tunnel && JSON.stringify(tunnel) === snapshot;
  if (!await consumeRequestedPluginRefreshStartup(current) || !current()) return;
  await startBridge();
  if (!current()) return;
  await connect(current);
  if (current()) wakeBrowserWork();
}
