import fs from 'node:fs';
import path from 'node:path';
import type { ChatBrowser } from '../../shared/types.js';

type ExternalChatBrowser = Exclude<ChatBrowser, 'cos'>;

const BASENAMES: Record<ExternalChatBrowser, RegExp> = {
  chrome: /^(?:google-chrome(?:-(?:stable|beta|unstable|dev))?|chromium(?:-browser)?|chrome|com\.google\.Chrome(?:Dev)?|org\.chromium\.Chromium)$/i,
  edge: /^(?:microsoft-edge(?:-(?:stable|beta|dev))?|msedge)$/i,
  brave: /^(?:brave|brave-browser(?:-(?:stable|beta|dev|nightly))?|com\.brave\.Browser)$/i,
  firefox: /^(?:firefox(?:-bin|-esr|-developer-edition|-nightly)?|org\.mozilla\.firefox)$/i
};

export function linuxBrowserExecutable(candidate: string, browser: ExternalChatBrowser): string | null {
  if (!path.isAbsolute(candidate) || /[\r\n\0]/.test(candidate)) return null;
  if (!BASENAMES[browser].test(path.basename(candidate))) return null;
  try {
    const stat = fs.statSync(candidate);
    if (!stat.isFile() || (process.platform === 'linux' && (stat.mode & 0o111) === 0)) return null;
    fs.accessSync(candidate, fs.constants.X_OK);
    return candidate;
  } catch {
    return null;
  }
}
