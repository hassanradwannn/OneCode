import { existsSync } from 'node:fs';
import path from 'node:path';
import { BUILD_CHANNEL, PRODUCT_LABEL } from '../shared/build-channel.js';

export const PRODUCT_NAME = PRODUCT_LABEL;
export const APP_ID = BUILD_CHANNEL === 'beta' ? 'io.onecode.desktop.beta' : 'io.onecode.desktop';
/** Development Electron must never register itself as the installed product. */
export function windowsAppId(packaged: boolean): string { return packaged ? APP_ID : `${APP_ID}.development`; }

/** Keep an existing installation in place so encrypted settings and chats survive the rename. */
export function appDataDirectory(
  appData: string,
  env: NodeJS.ProcessEnv = process.env,
  exists: (directory: string) => boolean = existsSync
): string {
  const override = env.ONECODE_USER_DATA?.trim() || env.GEMINI_CODE_USER_DATA?.trim();
  if (override) return path.resolve(override);
  const current = path.join(appData, PRODUCT_NAME);
  const legacy = path.join(appData, 'GeminiCode');
  return BUILD_CHANNEL === 'stable' && !exists(current) && exists(legacy) ? legacy : current;
}
