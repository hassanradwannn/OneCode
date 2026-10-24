import { providerText } from './provider-text.js';
import { displayBuildVersion } from '../shared/release-version.js';
import type { AppState } from '../shared/types.js';
import { isNewer } from '../shared/types.js';
import { selectedBrowserConnected } from '../shared/browser-readiness.js';
import { t } from './i18n.js';
import { updateErrorText } from './update-error.js';

interface ReadinessRow {
  id: string;
  label: string;
  status: 'pass' | 'fail' | 'not-run' | 'skipped';
  detail: string;
  reason?: string;
  nextStep?: string;
  schemaUnchecked?: boolean;
}

/** Projects existing owners only. Unknown, old proof and a dismissed reminder cannot pass. */
export function updateReadiness(next: AppState): ReadinessRow[] {
  const { update, bridge, status } = next;
  const appReady = update.stage === 'idle' && !update.latest && update.checkedAt != null && !update.betaFeedEmpty;
  const beta = update.channel === 'beta-branch';
  const betaCurrent = update.currentRevision?.slice(0, 12) ?? '';
  const betaLatest = update.latestRevision?.slice(0, 12) ?? '';
  const appDetail = update.stage === 'failed' ? t('Update check failed')
    : update.installRequested ? t('Restart requested; waiting for active work to finish')
    : update.stage === 'checking' ? t(beta ? 'Checking the Beta branch…' : 'Checking for a newer version…')
    : update.stage === 'downloading' ? t('Downloading {0}', [displayBuildVersion(update.latest!)])
    : beta && update.stage === 'ready' && betaLatest ? t('Beta revision {0} ready to restart', [betaLatest])
    : update.latest ? (update.stage === 'ready' ? t('Ready to install {0}', [displayBuildVersion(update.latest!)]) : t('Install {0} manually', [displayBuildVersion(update.latest!)]))
    : update.betaFeedEmpty ? t('No Beta update is published yet.')
    : appReady ? beta && update.betaRelation === 'local-ahead' ? t('Local beta branch is ahead of origin/beta') : t('Up to date') : t('Not checked yet');
  const browserConnected = selectedBrowserConnected(bridge, next.config.ui.chatBrowser);
  const extensionReady = browserConnected && bridge.extensionVersion === update.current &&
    bridge.externalExtension?.version === update.current && !bridge.extensionUpdateRequired;
  const extensionOlder = bridge.extensionUpdateRequired === true || !!bridge.extensionVersion && isNewer(update.current, bridge.extensionVersion);
  const appOlder = !!bridge.extensionVersion && isNewer(bridge.extensionVersion, update.current);
  const connectionFailed = ['offline', 'auth-failed', 'tunnel-unavailable'].includes(status.state);
  const rows: ReadinessRow[] = [
    { id: 'app', label: beta ? 'OneCode Beta' : 'OneCode', status: appReady ? 'pass' : update.stage === 'failed' ? 'fail' : 'not-run',
      detail: (beta && betaCurrent ? t('Revision {0}', [betaCurrent]) : t('Version {0}', [displayBuildVersion(update.current!)])) + ' · ' + appDetail,
      reason: update.stage === 'failed' && update.error ? updateErrorText(update.error) : undefined,
      nextStep: update.stage === 'failed' ? t('Choose Update all to retry. You can keep using the current app.')
        : next.platform?.family === 'macos' && update.stage === 'idle' && update.latest
          ? t('Finish active work and fully quit OneCode. Replace the app in /Applications, then open the updated app from there.') : undefined },
    { id: 'extension', label: t('Browser extension'), status: extensionReady ? 'pass' : 'not-run',
      detail: (bridge.extensionVersion ? t('Version {0}', [bridge.extensionVersion]) + ' · ' : '') +
        (extensionReady ? t('Connected') : !browserConnected ? t('Not connected') :
          bridge.extensionVersion ? t('App and extension versions differ') : t('Version not verified')),
      reason: !bridge.running ? bridge.error ?? undefined : undefined,
      nextStep: extensionReady ? undefined : extensionOlder
        ? t("Let active chats finish, then reload the browser extension in your browser.")
        : appOlder ? t('Choose Update all to check for updates and update the app.')
        : providerText("Open Gemini with the browser extension enabled, then choose Review setup.") }
  ];
  const surfaces = status.surfaces ?? [];
  if (!surfaces.some(surface => surface.id === 'core')) {
    rows.push({ id: 'core', label: t("Core plugin"), status: connectionFailed ? 'fail' : 'not-run', detail: t('Not connected'),
      reason: (connectionFailed || status.state === 'disconnected') && status.detail ? t(status.detail) : undefined,
      nextStep: t('Choose Review setup to check the connection, then choose Update all to retry.') });
  }
  for (const surface of surfaces) {
    const refresh = next.connectorRefresh?.[surface.id];
    const sameSchema = !!next.connectorSchemas?.[surface.id] && refresh?.schemaId === next.connectorSchemas[surface.id];
    const disabled = surface.optional && surface.state === 'off';
    const noTools = surface.optional && !disabled && surface.tools.length === 0;
    const off = disabled || noTools;
    const connected = surface.state === 'live' && status.state === 'connected';
    const verified = connected && surface.lastRequestAt != null && sameSchema && refresh?.state === 'current';
    const functional = connected && sameSchema && refresh?.responding === true;
    const surfaceFailed = surface.state === 'error' || connectionFailed;
    const detail = disabled ? t('Not enabled') : noTools ? t('No tools published') : !connected ? t('Not connected')
      : !sameSchema ? providerText('Not verified in Gemini')
      : functional && !verified && refresh?.state === 'unknown' ? t('Tool call succeeded; full tool definitions not verified')
      : refresh?.state === 'manual' ? providerText('Manual refresh required in Gemini')
      : refresh?.state === 'failed' ? t(refresh.failure !== 'confirmation' ? "Plugin check failed" : "Plugin refresh failed")
      : refresh?.state === 'refreshing' ? t('Waiting for refresh confirmation')
      : refresh?.state === 'pending' ? providerText('Refresh needed in Gemini')
      : refresh?.state !== 'current' ? providerText('Not verified in Gemini')
      : surface.lastRequestAt == null ? providerText('Waiting for a Gemini connection') : providerText('Verified in Gemini');
    const connectionDetail = surface.detail || status.detail;
    const reason = off ? undefined : !connected ? (surfaceFailed || status.state === 'disconnected') && connectionDetail ? t(connectionDetail) : undefined
      : sameSchema && refresh?.state === 'failed' ? refresh.failure === 'inspection'
        ? providerText("Could not inspect the installed plugin in Gemini.")
        : refresh.failure === 'migration' ? t("Could not verify the saved plugin against the current tool definitions.")
        : refresh.failure === 'confirmation' ? providerText("Could not confirm the plugin's current tool definitions in Gemini.") : undefined : undefined;
    const nextStep = off || verified ? undefined : !connected
      ? t('Choose Review setup to check the connection, then choose Update all to retry.')
      : sameSchema && refresh?.state === 'manual'
        ? providerText("In Gemini's plugin settings, refresh or recreate this plugin, then choose Update all to recheck.")
      : sameSchema && refresh?.state === 'failed' && refresh.failure === 'migration'
        ? providerText("In Gemini, refresh this existing plugin, then choose Update all to recheck. If Refresh is unavailable, save a Diagnostics report from Activity.")
      : sameSchema && refresh?.state === 'failed'
        ? providerText("Open this plugin's settings in Gemini, then choose Update all to recheck. If the check still fails, save a Diagnostics report from Activity.")
      : sameSchema && refresh?.state === 'refreshing'
        ? providerText("Wait for confirmation. If it does not arrive, open this plugin in Gemini and choose Update all to recheck.")
      : sameSchema && refresh?.state === 'current'
        ? providerText("Run a tool through this plugin in Gemini to confirm this connection.")
      : t("Choose Update all to check the installed plugin's tool definitions.");
    const row: ReadinessRow = { id: surface.id, label: surface.connectorName, reason, nextStep,
      schemaUnchecked: !off && functional && !verified,
      status: off ? 'skipped' : verified || (functional && refresh?.state === 'unknown') ? 'pass' : surfaceFailed || (sameSchema && refresh?.state === 'failed') ? 'fail' : 'not-run', detail };
    if (surface.id === 'desktop' && !off && connected && next.platform?.family === 'macos') {
      const permissions = [
        ...(next.config.capabilities.screen ? [{ label: 'Screen Recording: {0}', state: next.desktopAccess?.screen ?? 'unknown' }] : []),
        ...(next.config.capabilities.control && !next.config.readOnly ? [{ label: 'Accessibility: {0}', state: next.desktopAccess?.accessibility ?? 'unknown' }] : [])
      ].filter(permission => permission.state !== 'granted');
      if (permissions.length) {
        // The native backend owns these verdicts. Reading them never requests an OS grant.
        row.status = row.status === 'fail' || permissions.some(permission => permission.state === 'missing') ? 'fail' : 'not-run';
        row.reason = [row.reason, ...permissions.map(permission => t(permission.label, [t(permission.state === 'missing' ? 'required' : 'unknown')]))].filter(Boolean).join(' · ');
        row.nextStep = [row.nextStep, t('Choose Review setup to check macOS permissions, then fully quit and reopen the app.')].filter(Boolean).join(' ');
      }
    }
    rows.push(row);
  }
  return rows;
}
