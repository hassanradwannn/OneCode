import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Root } from '../../shared/types.js';
import type { ChatProvider } from '../../shared/chat-provider.js';
import { resolvePath } from '../sandbox.js';
import { MAX_RECORDED_VIDEO_BYTES, writeAsset } from '../session/store.js';
import { requirePendingPresentation, writePresentation } from './presentation.js';

/** Copies a completed approved local video into the session; playback never exposes its source path. */
export async function presentVideo(sessionId: string, id: string, provider: ChatProvider, roots: readonly Root[], file: string) {
  const pending = await requirePendingPresentation(sessionId, id, 'video', provider);
  const resolved = await resolvePath(roots, file), handle = await fs.open(resolved.real, 'r');
  let data: Buffer;
  try {
    const before = await handle.stat();
    if (!before.isFile() || !before.size || before.size > MAX_RECORDED_VIDEO_BYTES) throw new Error('Use a completed MP4 or WebM video up to 128 MiB');
    data = Buffer.alloc(before.size); let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await handle.read(data, offset, data.length - offset, offset);
      if (!bytesRead) throw new Error('Video changed while it was being read'); offset += bytesRead;
    }
    const checked = await resolvePath(roots, file), after = await fs.stat(checked.real), held = await handle.stat();
    if (checked.real !== resolved.real || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || held.size !== before.size || held.mtimeMs !== before.mtimeMs)
      throw new Error('Video changed while it was being read');
  } finally { await handle.close(); }
  const ext = path.extname(resolved.real).toLowerCase();
  const mimeType = ext === '.mp4' && data.length >= 12 && data.toString('ascii', 4, 8) === 'ftyp' ? 'video/mp4'
    : ext === '.webm' && data.length >= 4 && data.readUInt32BE(0) === 0x1a45dfa3 ? 'video/webm' : null;
  if (!mimeType) throw new Error('Use an MP4 or WebM video with a matching container');
  const asset = await writeAsset(sessionId, data, mimeType);
  const result = { ...pending, status: 'ready' as const, asset };
  await writePresentation(sessionId, result); return result;
}
