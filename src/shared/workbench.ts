export type WorkbenchSurfaceKind =
  | 'review'
  | 'files'
  | 'agents'
  | 'terminal'
  | 'artifact'
  | 'browser'
  | 'media'
  | 'document';

/** Stable identity for one projection in OneCode's shared Workbench slot. */
export interface WorkbenchSurfaceRef {
  id: string;
  kind: WorkbenchSurfaceKind;
  title: string;
  icon: string;
  sessionId?: string;
  projectId?: string;
  closable: boolean;
  dirty?: boolean;
}

/** Renderer-owned layout state. Surface content is restored by its domain owner. */
export interface WorkbenchLayoutState {
  opened: string[];
  active: string | null;
  rightOpen: boolean;
  expanded: boolean;
}
