export interface WorkbenchBrowserTab {
  id: number;
  sessionId: string;
  title: string;
  url: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  modelControlled: boolean;
  previewConflict?: true;
}

export interface WorkbenchBrowserState {
  sessionId: string;
  tabs: WorkbenchBrowserTab[];
  activeId: number | null;
}

export interface WorkbenchBrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Automatic site previews are limited to local HTTP servers with an explicit port. */
export function localWorkbenchUrl(value: string): string | null {
  if (!value || value.length > 2048 || /[\s\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && workbenchLoopbackPort(url.href) !== null &&
      url.port && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

/** Local aliases can address the same listener even when the URL paths differ. */
export function workbenchLoopbackPort(value: string): number | null {
  try {
    const url = new URL(value);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return null;
    const host = url.hostname.replace(/\.$/, '');
    if (host !== 'localhost' && !host.endsWith('.localhost') && host !== '[::1]' &&
        !/^\[::ffff:7f[\da-f]{2}:[\da-f]{1,4}\]$/i.test(host) && !/^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(host)) return null;
    return Number(url.port || (['https:', 'wss:'].includes(url.protocol) ? 443 : 80));
  } catch { return null; }
}

/** The human address bar accepts hostnames without a scheme. Tool URLs remain explicit. */
export function workbenchAddress(value: string): string {
  const address = value.trim();
  if (/^(?:localhost\.?|127\.(?:\d{1,3}\.){2}\d{1,3}|\[::1\])(?=[:/?#]|$)/i.test(address)) return 'http://' + address;
  if (/^(?:[\p{L}\d-]+\.)+[\p{L}\d-]+(?=[:/?#]|$)/iu.test(address)) return 'https://' + address;
  return address;
}

/**
 * Renderer layout coordinates are CSS pixels. A native WebContentsView is positioned in
 * BrowserWindow content DIPs, so Electron page zoom must be applied exactly once here. OS display
 * scale is deliberately absent: both BrowserWindow bounds and WebContentsView bounds are already
 * expressed in DIPs.
 */
export function workbenchBrowserContentBounds(
  value: WorkbenchBrowserBounds, zoomFactor: number, content: { width: number; height: number }
): WorkbenchBrowserBounds {
  const zoom = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
  const x = Math.max(0, Math.min(content.width, Math.round(value.x * zoom)));
  const y = Math.max(0, Math.min(content.height, Math.round(value.y * zoom)));
  return {
    x, y,
    width: Math.max(0, Math.min(content.width - x, Math.round(value.width * zoom))),
    height: Math.max(0, Math.min(content.height - y, Math.round(value.height * zoom)))
  };
}
