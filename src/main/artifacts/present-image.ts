import { promises as fs } from 'node:fs';
import sharp from 'sharp';
import type { Root } from '../../shared/types.js';
import type { ChatProvider } from '../../shared/chat-provider.js';
import { resolvePath } from '../sandbox.js';
import { MAX_ASSET_BYTES, writeAsset } from '../session/store.js';
import { requirePendingPresentation, writePresentation } from './presentation.js';

/** Explicit local image output, supported identically for every provider. No provider URL ingestion. */
export async function presentImage(sessionId: string, id: string, provider: ChatProvider, roots: readonly Root[], file: string) {
  const pending = await requirePendingPresentation(sessionId, id, 'image', provider);
  const resolved = await resolvePath(roots, file);
  const handle = await fs.open(resolved.real, 'r');
  let data: Buffer;
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size === 0 || before.size > MAX_ASSET_BYTES) throw new Error('Image exceeds the recording limit or is not a regular file');
    data = Buffer.alloc(before.size); let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await handle.read(data, offset, data.length - offset, offset);
      if (!bytesRead) throw new Error('Image changed while it was being read'); offset += bytesRead;
    }
    const checked = await resolvePath(roots, file), after = await fs.stat(checked.real), held = await handle.stat();
    if (checked.real !== resolved.real || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || held.size !== before.size || held.mtimeMs !== before.mtimeMs)
      throw new Error('Image changed while it was being read');
  } finally { await handle.close(); }
  const image = sharp(data, { limitInputPixels: 16_000_000, animated: false });
  const metadata = await image.metadata();
  if (!['png', 'jpeg', 'webp'].includes(metadata.format ?? '')) throw new Error('Use a PNG, JPEG or WebP image');
  const { data: bytes, info } = await image.rotate().png().toBuffer({ resolveWithObject: true });
  const asset = await writeAsset(sessionId, bytes, 'image/png');
  const result = { ...pending, status: 'ready' as const, asset: { ...asset, width: info.width, height: info.height } };
  await writePresentation(sessionId, result); return result;
}
