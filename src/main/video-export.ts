/** Chunked original-video export from an authenticated provider page into an approved target. */
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import path from 'node:path';
import { rawPromises as fs } from './rawfs.js';
import { wakeBrowserWork } from './browser-wake.js';
import { logInfo } from './logger.js';
import { canExportNativeOutput } from '../shared/native-output.js';

export const MAX_VIDEO_EXPORT_BYTES = 256 * 1024 * 1024;
export const VIDEO_EXPORT_CHUNK_BYTES = 512 * 1024;
export const VIDEO_EXPORT_BODY_BYTES = Math.ceil(VIDEO_EXPORT_CHUNK_BYTES / 3) * 4 + 32 * 1024;
export const VIDEO_EXPORT_TIMEOUT_MS = 180_000;
const NO_HARD_LINKS = new Set(['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EPERM', 'EXDEV', 'EMLINK']);
const EXTENSIONS = { 'video/mp4': '.mp4', 'video/webm': '.webm' } as const;

export interface VideoExportTarget { real: string; virtual: string; validate?: () => Promise<void> }
export interface VideoExportSource { conversationId: string; messageId: string; assetId: string; mimeType: keyof typeof EXTENSIONS }
export interface VideoExportResult { virtual: string; mimeType: keyof typeof EXTENSIONS; bytes: number; sha256: string }
export class VideoExportError extends Error {}

interface Pending {
  nonce: string; source: VideoExportSource; target: VideoExportTarget; file: string; virtual: string; temporary: string;
  expiresAt: number; bytes: number; hash: ReturnType<typeof createHash>; handle: Awaited<ReturnType<typeof fs.open>> | null;
  queue: Promise<void>; settled: boolean; settle: (value: VideoExportResult | Error) => void; timer: NodeJS.Timeout;
}
const pending = new Map<string, Pending>();

const PAGE_ERRORS: Record<string, string> = {
  not_open: 'the chat is not open in the provider browser.', not_rendered: 'the generated video is not mounted on the provider page right now.',
  fetch_failed: 'the provider page could not read the generated video.', not_video: 'the provider returned something that is not the expected video container.',
  too_large: `the generated video is larger than ${MAX_VIDEO_EXPORT_BYTES / 1024 / 1024} MB.`, unsupported: 'this browser companion cannot export generated videos yet.',
  identity_changed: 'the provider page changed before the exact video could be transferred.'
};

function finalNames(target: VideoExportTarget, mimeType: keyof typeof EXTENSIONS): { file: string; virtual: string } {
  const own = EXTENSIONS[mimeType], ext = path.extname(target.real).toLowerCase();
  if (!ext) return { file: target.real + own, virtual: target.virtual + own };
  if (ext !== own) throw new VideoExportError(`the generated video is ${mimeType}; name the file with ${own} (or leave the extension out).`);
  return { file: target.real, virtual: target.virtual };
}

async function cleanup(entry: Pending): Promise<void> {
  const handle = entry.handle; entry.handle = null;
  if (handle) await handle.close().catch(() => undefined);
  await fs.rm(entry.temporary, { force: true }).catch(() => undefined);
}

function finish(entry: Pending, value: VideoExportResult | Error): void {
  if (entry.settled || pending.get(entry.nonce) !== entry) return; entry.settled = true; pending.delete(entry.nonce); clearTimeout(entry.timer);
  // A timeout cannot race a still-opening/writing handle and leave a late .part behind.
  void entry.queue.finally(() => cleanup(entry)).finally(() => entry.settle(value));
}

export function exportVideo(source: VideoExportSource, target: VideoExportTarget, timeoutMs = VIDEO_EXPORT_TIMEOUT_MS): Promise<VideoExportResult> {
  if (!canExportNativeOutput(source.conversationId, 'video')) return Promise.reject(new VideoExportError('Original video export is not available for this provider yet.'));
  const names = finalNames(target, source.mimeType);
  return new Promise((resolve, reject) => {
    const nonce = randomUUID(), temporary = path.join(path.dirname(names.file), `.${path.basename(names.file)}.${nonce}.part`);
    const timer = setTimeout(() => { const entry = pending.get(nonce); if (entry) finish(entry, new VideoExportError('the browser did not deliver the video in time.')); }, timeoutMs); timer.unref?.();
    const entry: Pending = { nonce, source, target, file: names.file, virtual: names.virtual, temporary, expiresAt: Date.now() + timeoutMs, bytes: 0,
      hash: createHash('sha256'), handle: null, queue: Promise.resolve(), settled: false, timer, settle: value => value instanceof Error ? reject(value) : resolve(value) };
    pending.set(nonce, entry); logInfo(`video export requested id=${nonce} conversation=${source.conversationId}`); wakeBrowserWork();
  });
}

export function pendingVideoExports(now = Date.now()): Array<{ nonce: string; conversationId: string; messageId: string; assetId: string; mimeType: string; maxBytes: number; chunkBytes: number }> {
  for (const entry of [...pending.values()]) if (now >= entry.expiresAt) finish(entry, new VideoExportError('the browser did not deliver the video in time.'));
  return [...pending.values()].map(entry => ({ nonce: entry.nonce, conversationId: entry.source.conversationId, messageId: entry.source.messageId,
    assetId: entry.source.assetId, mimeType: entry.source.mimeType, maxBytes: MAX_VIDEO_EXPORT_BYTES, chunkBytes: VIDEO_EXPORT_CHUNK_BYTES }));
}

async function ensureHandle(entry: Pending): Promise<Awaited<ReturnType<typeof fs.open>>> {
  if (entry.handle) return entry.handle; await entry.target.validate?.(); await fs.mkdir(path.dirname(entry.file), { recursive: true });
  entry.handle = await fs.open(entry.temporary, 'wx'); return entry.handle;
}

async function readAt(file: string, length: number, position: number): Promise<Buffer> {
  const handle = await fs.open(file, 'r');
  try { const buffer = Buffer.alloc(length); const { bytesRead } = await handle.read(buffer, 0, length, position); return buffer.subarray(0, bytesRead); }
  finally { await handle.close(); }
}

async function validateMp4(file: string, bytes: number): Promise<void> {
  let offset = 0, boxes = 0, ftyp = false, moov = false, mdat = false;
  while (offset < bytes && boxes++ < 100_000) {
    const head = await readAt(file, 16, offset); if (head.length < 8) throw new VideoExportError('the provider delivered a truncated MP4.');
    let size = head.readUInt32BE(0), header = 8; const type = head.toString('ascii', 4, 8);
    if (size === 1) { if (head.length < 16) throw new VideoExportError('the provider delivered a truncated MP4.'); const big = head.readBigUInt64BE(8); if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new VideoExportError('the MP4 container is too large.'); size = Number(big); header = 16; }
    else if (size === 0) size = bytes - offset;
    if (size < header || offset + size > bytes) throw new VideoExportError('the provider delivered an invalid MP4 box layout.');
    if (offset === 0 && type !== 'ftyp') throw new VideoExportError('the provider file is not an MP4 container.');
    if (type === 'ftyp') ftyp = true; else if (type === 'moov') moov = true; else if (type === 'mdat') mdat = true;
    offset += size;
  }
  if (offset !== bytes || !ftyp || !moov || !mdat) throw new VideoExportError('the provider delivered an incomplete MP4 container.');
}

function readEbmlVint(buffer: Buffer, offset: number): { value: number; length: number } | null {
  const first = buffer[offset]; if (!first) return null; let mask = 0x80, length = 1; while (length <= 8 && !(first & mask)) { mask >>= 1; length++; }
  if (length > 8 || offset + length > buffer.length) return null; let value = first & (mask - 1);
  for (let i = 1; i < length; i++) value = value * 256 + buffer[offset + i]!; return { value, length };
}

async function validateWebm(file: string, bytes: number): Promise<void> {
  if (bytes < 32) throw new VideoExportError('the provider delivered a truncated WebM.');
  const scan = await readAt(file, Math.min(bytes, 16 * 1024 * 1024), 0);
  if (scan.length < 4 || !scan.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) throw new VideoExportError('the provider file is not a WebM container.');
  const docTypeAt = scan.indexOf(Buffer.from([0x42, 0x82])); let webm = false;
  if (docTypeAt >= 0) { const size = readEbmlVint(scan, docTypeAt + 2); if (size && size.value > 0 && size.value <= 16 && docTypeAt + 2 + size.length + size.value <= scan.length) {
    webm = scan.toString('ascii', docTypeAt + 2 + size.length, docTypeAt + 2 + size.length + size.value).toLowerCase() === 'webm'; } }
  const segment = scan.indexOf(Buffer.from([0x18, 0x53, 0x80, 0x67])); const cluster = scan.indexOf(Buffer.from([0x1f, 0x43, 0xb6, 0x75]));
  if (!webm || segment < 0 || cluster < 0 || cluster <= segment) throw new VideoExportError('the provider delivered an incomplete WebM container.');
}

async function validateContainer(entry: Pending): Promise<void> {
  if (entry.source.mimeType === 'video/mp4') await validateMp4(entry.temporary, entry.bytes); else await validateWebm(entry.temporary, entry.bytes);
}

async function publish(entry: Pending): Promise<VideoExportResult> {
  if (!entry.handle) throw new VideoExportError('the provider delivered an empty video.'); await entry.handle.sync(); await entry.handle.close(); entry.handle = null;
  await validateContainer(entry);
  await entry.target.validate?.();
  if (entry.settled || pending.get(entry.nonce) !== entry) throw new VideoExportError('Video transfer was cancelled before publication.');
  // From this point publication owns the outcome; a timer must not report failure after the file was committed.
  clearTimeout(entry.timer);
  try {
    try { await fs.link(entry.temporary, entry.file); }
    catch (error) { if (!NO_HARD_LINKS.has((error as NodeJS.ErrnoException).code ?? '')) throw error; await fs.copyFile(entry.temporary, entry.file, constants.COPYFILE_EXCL); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new VideoExportError(`${entry.virtual} already exists. Choose another name.`); throw error; }
  return { virtual: entry.virtual, mimeType: entry.source.mimeType, bytes: entry.bytes, sha256: entry.hash.digest('hex') };
}

/** Accepts one ordered chunk or terminal marker. Concurrent requests serialize per nonce. */
export async function completeVideoExportChunk(raw: unknown): Promise<boolean> {
  const body = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}; const entry = typeof body.nonce === 'string' ? pending.get(body.nonce) : undefined;
  if (!entry || entry.settled) return false;
  entry.queue = entry.queue.then(async () => {
    if (entry.settled || pending.get(entry.nonce) !== entry) return;
    if (typeof body.error === 'string') { finish(entry, new VideoExportError(PAGE_ERRORS[body.error] ?? 'the browser could not read the video.')); return; }
    if (body.done === true) {
      if (!Number.isSafeInteger(body.totalBytes) || body.totalBytes !== entry.bytes || entry.bytes <= 0) { finish(entry, new VideoExportError('the browser ended the video transfer at an unexpected byte offset.')); return; }
      try { const result = await publish(entry); if (pending.get(entry.nonce) === entry && !entry.settled) { entry.settled = true; pending.delete(entry.nonce); clearTimeout(entry.timer); await fs.rm(entry.temporary, { force: true }); entry.settle(result); logInfo(`video export saved ${result.virtual} (${result.bytes} bytes ${result.sha256.slice(0, 12)})`); } }
      catch (error) { finish(entry, error instanceof VideoExportError ? error : new VideoExportError(`the video could not be saved: ${(error as Error).message}`)); }
      return;
    }
    if (!Number.isSafeInteger(body.offset) || body.offset !== entry.bytes || typeof body.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.data)) {
      finish(entry, new VideoExportError('the browser sent an out-of-order or unreadable video chunk.')); return;
    }
    const chunk = Buffer.from(body.data, 'base64');
    if (!chunk.length || chunk.length > VIDEO_EXPORT_CHUNK_BYTES || entry.bytes + chunk.length > MAX_VIDEO_EXPORT_BYTES) { finish(entry, new VideoExportError(PAGE_ERRORS.too_large!)); return; }
    try { const handle = await ensureHandle(entry); await handle.write(chunk, 0, chunk.length, entry.bytes); entry.hash.update(chunk); entry.bytes += chunk.length; }
    catch (error) { finish(entry, new VideoExportError(`the video could not be staged: ${(error as Error).message}`)); }
  }).catch(error => finish(entry, error instanceof Error ? error : new VideoExportError('video transfer failed')));
  await entry.queue; return true;
}

export function resetVideoExportsForTests(): void { for (const entry of [...pending.values()]) finish(entry, new VideoExportError('reset')); }
