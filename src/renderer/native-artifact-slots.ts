import type { ArtifactPresentation } from '../shared/artifact.js';
import { nativeMessageMarkup } from './native-message-content.js';

/** Presentation-only join. No text matching, title heuristics, activity or turn ownership. */
export function nativeArtifactBindings(capture: { text: string; truncated: boolean } | null | undefined,
  messageId: string | undefined, presentations: readonly ArtifactPresentation[]): Map<string, ArtifactPresentation> {
  const result = new Map<string, ArtifactPresentation>();
  const markup = nativeMessageMarkup(capture, messageId);
  if (!markup) return result;
  const template = document.createElement('template'); template.innerHTML = markup;
  const slots = [...template.content.querySelectorAll('[data-onecode-native-surface]')];
  if (slots.length > 16) return result;
  for (const node of slots) {
    if (node.closest('[hidden],[aria-hidden="true"],pre,code,script,style,svg,template') ||
        node.parentElement?.closest('[data-onecode-native-surface]')) continue;
    const surface = node.getAttribute('data-onecode-native-surface') || '';
    if (!surface || surface.length > 700 || slots.filter(other => other.getAttribute('data-onecode-native-surface') === surface).length !== 1) continue;
    const matches = presentations.filter(item => item.status === 'ready' && item.artifactId &&
      item.nativeSource?.messageId === messageId && item.nativeSource?.surface === surface);
    if (matches.length === 1) result.set(surface, matches[0]!);
  }
  return result;
}

export function hiddenNativePresentations(capture: { text: string; truncated: boolean } | null | undefined,
  messageId: string | undefined, presentations: readonly ArtifactPresentation[]): Set<string> {
  const hidden = new Set([...nativeArtifactBindings(capture, messageId, presentations).values()].map(item => item.id));
  const markup = nativeMessageMarkup(capture, messageId);
  if (!markup) return hidden;
  const template = document.createElement('template'); template.innerHTML = markup;
  const root = template.content.firstElementChild;
  if (root?.getAttribute('data-onecode-native-inventory') !== 'dil') return hidden;
  const slots = [...root.querySelectorAll('[data-onecode-native-surface]')].map(node => node.getAttribute('data-onecode-native-surface'));
  for (const item of presentations) if (item.nativeSource?.messageId === messageId &&
      item.nativeSource && /^dil:\d+$/.test(item.nativeSource.surface) && !slots.includes(item.nativeSource.surface)) hidden.add(item.id);
  return hidden;
}
