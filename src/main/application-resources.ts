import path from 'node:path';
import { promises as fs } from 'node:fs';
import { app } from 'electron';

interface ActiveApplicationLayer { root: string; appAsar: string; version: string; runtime: string }

/** Mutable application resources follow the exact Linux sidecar selected by the immutable bootstrap. */
export function activeApplicationLayer(): ActiveApplicationLayer | null {
  const value = (globalThis as typeof globalThis & { __onecodeApplicationLayer?: ActiveApplicationLayer }).__onecodeApplicationLayer;
  return value?.root && value?.appAsar ? value : null;
}

export function packagedApplicationResources(): string {
  return process.platform === 'linux' ? activeApplicationLayer()?.root ?? process.resourcesPath : process.resourcesPath;
}

/** The executable application archive/root. Electron's own app.getAppPath() remains the immutable
 * complete base, so Linux code that needs renderer/preload bytes must explicitly follow the
 * verified sidecar selected by bootstrap. */
export function packagedApplicationAppPath(): string {
  return process.platform === 'linux' ? activeApplicationLayer()?.appAsar ?? app.getAppPath() : app.getAppPath();
}

export function packagedApplicationResource(...segments: string[]): string {
  return path.join(packagedApplicationResources(), ...segments);
}

/** A sidecar is trusted only after its first renderer reaches ready-to-show. Clearing this marker
 * makes the selection durable; if the process dies earlier the immutable bootstrap rolls back on
 * the next start instead of boot-looping the hotfix. */
export async function confirmActiveApplicationLayer(): Promise<void> {
  if (process.platform !== 'linux' || !activeApplicationLayer()) return;
  const layers = path.join(app.getPath('userData'), 'application-layers');
  await fs.rm(path.join(layers, 'launching.json'), { force: true }).catch(() => undefined);
  await fs.rm(path.join(layers, 'rollback.json'), { force: true }).catch(() => undefined);
}
