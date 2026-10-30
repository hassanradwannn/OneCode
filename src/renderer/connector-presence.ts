import type { SurfaceStatus } from '../shared/types.js';

/** Presentation only: the connection owner has already scoped persisted proof
 * to this exact provider, setup profile and public route. Restart is not removal. */
export function pluginCreated(surface: Pick<SurfaceStatus, 'lastRequestAt' | 'proof'>): boolean {
  return [surface.lastRequestAt, surface.proof?.requestAt, surface.proof?.toolCallAt, surface.proof?.installedAt]
    .some(at => typeof at === 'number' && Number.isFinite(at) && at > 0);
}
