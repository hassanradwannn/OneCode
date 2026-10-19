export const ARTIFACT_VIEWPORTS = {
  landscape: { width: 1600, height: 900, label: '16:9 · Desktop' },
  portrait: { width: 450, height: 800, label: '9:16 · Phone' }
} as const;
export type ArtifactViewport = keyof typeof ARTIFACT_VIEWPORTS;

/** Scale the browser viewport, never reflow it to the chat card's dimensions. */
export function fitArtifactViewport(mode: ArtifactViewport, width: number, height: number) {
  const viewport = ARTIFACT_VIEWPORTS[mode];
  const scale = Math.max(0, Math.min(width / viewport.width, height / viewport.height));
  return { ...viewport, scale, left: Math.max(0, (width - viewport.width * scale) / 2),
    top: Math.max(0, (height - viewport.height * scale) / 2) };
}
