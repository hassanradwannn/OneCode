import type { ArtifactOpenRequest } from '../../shared/artifact.js';

const openListeners = new Set<(request: ArtifactOpenRequest) => void>();

export function onArtifactOpen(listener: (request: ArtifactOpenRequest) => void): () => void {
  openListeners.add(listener);
  return () => openListeners.delete(listener);
}

export function requestArtifactOpen(request: ArtifactOpenRequest): void {
  for (const listener of openListeners) listener(request);
}
