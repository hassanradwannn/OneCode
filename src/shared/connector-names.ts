/**
 * The names this install's connectors carry in Gemini.
 *
 * Gemini records a connector's tool calls under the exact name the user typed for it (the call
 * path, `invocation.server` and `invoked_resource.app_name` carry its native name). New custom-app
 * creation strips parentheses (checked 2026-10-17), so generated names use a plain space suffix.
 * The extension recognizes this app's own traffic
 * by those exact names, never by prefix, so it never vouches for another connector's calls.
 *
 * One Gemini account used on two computers needs two connectors per surface, and they cannot
 * share a name: a suffix names this computer's set, e.g. "OneCode Core Windows".
 */
export const CONNECTOR_BRAND = 'OneCode';
export const CONNECTOR_SUFFIX_MAX = 32;
/** Letters, digits, spaces, dots, dashes and underscores. */
export const CONNECTOR_SUFFIX_PATTERN = /^[\p{L}\p{N} ._-]*$/u;

export type ConnectorSurface = 'core' | 'desktop' | 'plugins';
const SURFACE_WORD: Record<ConnectorSurface, string> = { core: 'Core', desktop: 'Desktop', plugins: 'Plugins' };

/** A usable suffix, or '' for anything empty, too long or outside the allowed characters. */
export function normalizeConnectorSuffix(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim().replace(/\s+/g, ' ');
  return trimmed.length <= CONNECTOR_SUFFIX_MAX && CONNECTOR_SUFFIX_PATTERN.test(trimmed) ? trimmed : '';
}

export function connectorName(surface: ConnectorSurface, suffix: unknown = ''): string {
  const plain = `${CONNECTOR_BRAND} ${SURFACE_WORD[surface]}`;
  const tag = normalizeConnectorSuffix(suffix);
  return tag ? `${plain} ${tag}` : plain;
}

/**
 * Linux is an additional physical OneCode device for most existing installs. Give a fresh or
 * previously-blank Linux connector a distinct provider-visible identity instead of colliding with
 * the historical unsuffixed Windows connector. An explicit user suffix always wins.
 */
export function connectorSuffixForPlatform(value: unknown, platform: NodeJS.Platform): string {
  return normalizeConnectorSuffix(value) || (platform === 'linux' ? 'Linux' : '');
}

export function connectorNames(suffix: unknown = ''): Record<ConnectorSurface, string> {
  return { core: connectorName('core', suffix), desktop: connectorName('desktop', suffix), plugins: connectorName('plugins', suffix) };
}
