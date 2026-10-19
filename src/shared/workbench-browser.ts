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
