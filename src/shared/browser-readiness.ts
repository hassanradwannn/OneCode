import type { BridgeStatus, ChatBrowser } from './types.js';

/** Saved installation/login proof never supplies a live external browser connection. */
export function selectedBrowserConnected(bridge: BridgeStatus, browser: ChatBrowser = 'chrome'): boolean {
  const external = bridge.externalExtension;
  return browser !== 'cos' && bridge.running && bridge.paired && bridge.present && external?.present === true &&
    ((browser === 'firefox') === (external.engine === 'gecko'));
}
