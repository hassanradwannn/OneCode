/** Read-only diagnostics for the main native window; no presentation authority. */
type WindowEvent = 'minimize' | 'restore' | 'hide' | 'show' | 'close';
type SystemCommand = 'minimize' | 'restore' | 'close' | 'maximize';
export type WindowPresentationEvent = WindowEvent | `system-${SystemCommand}` | 'observer-attached' | 'system-observer-unavailable';
export interface WindowPresentationObservation {
  event: WindowPresentationEvent;
  visible: boolean;
  minimized: boolean;
  focused: boolean;
  maximized: boolean;
  quitting: boolean;
}
interface WindowPresentationOwner {
  on(event: WindowEvent, listener: () => void): unknown;
  once(event: 'closed', listener: () => void): unknown;
  removeListener(event: WindowEvent | 'closed', listener: () => void): unknown;
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
  isFocused(): boolean;
  isMaximized(): boolean;
  hookWindowMessage?(message: number, callback: (wParam: Buffer, lParam: Buffer) => void): void;
  unhookWindowMessage?(message: number): void;
  isWindowMessageHooked?(message: number): boolean;
}
const WM_SYSCOMMAND = 0x0112;
const WINDOW_EVENTS: readonly WindowEvent[] = ['minimize', 'restore', 'hide', 'show', 'close'];

/** Discard message flags and all other native data; recognize only these four commands. */
export function windowSystemCommand(wParam: Buffer): SystemCommand | null {
  if (wParam.length < 4) return null;
  switch (wParam.readUInt32LE(0) & 0xfff0) {
    case 0xf020: return 'minimize';
    case 0xf120: return 'restore';
    case 0xf060: return 'close';
    case 0xf030: return 'maximize';
    default: return null;
  }
}

/** The existing bounded logger owns storage. Failures here must not affect native events. */
export function observeWindowPresentation(
  owner: WindowPresentationOwner,
  report: (observation: WindowPresentationObservation) => void,
  quitting: () => boolean,
  platform: NodeJS.Platform = process.platform
): () => void {
  let disposed = false, hooked = false;
  const capture = (event: WindowPresentationEvent): void => {
    try {
      if (disposed || owner.isDestroyed()) return;
      report({ event, visible: owner.isVisible(), minimized: owner.isMinimized(),
        focused: owner.isFocused(), maximized: owner.isMaximized(), quitting: quitting() });
    } catch { /* Diagnostics cannot alter window behavior or propagate a native callback failure. */ }
  };
  const listeners = WINDOW_EVENTS.map(event => ({ event, listener: () => capture(event) }));
  for (const { event, listener } of listeners) owner.on(event, listener);
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    for (const { event, listener } of listeners) owner.removeListener(event, listener);
    owner.removeListener('closed', dispose);
    try { if (hooked && !owner.isDestroyed()) owner.unhookWindowMessage?.(WM_SYSCOMMAND); }
    catch { /* A window that closed already has no native hook to release. */ }
  };
  owner.once('closed', dispose);
  capture('observer-attached');
  if (platform === 'win32') {
    try {
      // Never replace another owner's hook. This observes WndProc; it neither consumes
      // the message nor records raw parameters, input, coordinates or window identities.
      if (!owner.hookWindowMessage || !owner.unhookWindowMessage || owner.isWindowMessageHooked?.(WM_SYSCOMMAND)) {
        capture('system-observer-unavailable');
      } else {
        owner.hookWindowMessage(WM_SYSCOMMAND, wParam => {
          const command = windowSystemCommand(wParam);
          if (command) capture(`system-${command}`);
        });
        hooked = true;
      }
    } catch { capture('system-observer-unavailable'); }
  }
  return dispose;
}
