export interface WorkbenchBrowserTab {
  id: number;
  sessionId: string;
  title: string;
  url: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  modelControlled: boolean;
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
