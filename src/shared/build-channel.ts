/** Build-time release channel. The packaged bundle is immutable and carries this value. */
export type BuildChannel = 'stable' | 'beta';
declare const __ONECODE_BUILD_CHANNEL__: BuildChannel;
export const BUILD_CHANNEL: BuildChannel = typeof __ONECODE_BUILD_CHANNEL__ === 'undefined' ? 'stable' : __ONECODE_BUILD_CHANNEL__;
export const PRODUCT_LABEL = BUILD_CHANNEL === 'beta' ? 'OneCode Beta' : 'OneCode';
export function channelVersion(version: string): string {
  return BUILD_CHANNEL === 'beta' ? `${version} Beta` : version;
}

