import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { app } from 'electron';
import { promises as fs } from 'node:fs';
import { canExportNativeOutput } from '../shared/native-output.js';
import type { NativeMediaItem, NativeMediaSaveResult, NativeVideoPlayback, NativeVideoPlaybackChunk } from '../shared/native-media.js';
import { nativeMediaItem } from '../shared/native-media.js';
import type { SessionEvent } from '../shared/session.js';
import { exportImage } from './image-export.js';
import { getSessionProject } from './projects.js';
import { getSession, readEvents } from './session/store.js';
import { exportVideo } from './video-export.js';
import { getConfig } from './config.js';
import { nativePathIdentity, resolvePath } from './sandbox.js';

type MediaEvent = Extract<SessionEvent, { kind: 'native_image' | 'native_video' }>;
const PLAYBACK_TTL_MS = 30 * 60_000;
const PLAYBACK_CHUNK_BYTES = 1024 * 1024;
type Playback = { sessionId: string; file: string; mimeType: 'video/mp4' | 'video/webm'; bytes: number; expiresAt: number; timer?: ReturnType<typeof setTimeout> };
const playbacks = new Map<string, Playback>();

async function removePlayback(token: string, value: Playback): Promise<void> {
  if (playbacks.get(token) === value) playbacks.delete(token);
  if (value.timer) clearTimeout(value.timer);
  await fs.rm(value.file, { force: true }).catch(() => undefined);
}

function touchPlayback(token: string, value: Playback, now = Date.now()): void {
  if (value.timer) clearTimeout(value.timer);
  value.expiresAt = now + PLAYBACK_TTL_MS;
  value.timer = setTimeout(() => { if (playbacks.get(token) === value) void removePlayback(token, value); }, PLAYBACK_TTL_MS);
  value.timer.unref?.();
}

async function reapPlaybacks(now = Date.now()): Promise<void> {
  for (const [token, value] of playbacks) if (now >= value.expiresAt) await removePlayback(token, value);
}

async function playbackDirectory(now = Date.now()): Promise<string> {
  const dir = path.join(app.getPath('temp'), 'onecode-native-media'); await fs.mkdir(dir, { recursive: true });
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries.filter(entry => entry.isFile()).map(async entry => {
    const file = path.join(dir, entry.name); const stat = await fs.stat(file).catch(() => null);
    if (stat && now - stat.mtimeMs >= PLAYBACK_TTL_MS) await fs.rm(file, { force: true }).catch(() => undefined);
  }));
  return dir;
}

async function canonicalMedia(sessionId: string): Promise<MediaEvent[]> {
  const latest = new Map<string, MediaEvent>();
  for (const event of await readEvents(sessionId)) {
    if (event.kind !== 'native_image' && event.kind !== 'native_video') continue;
    const key = `${event.kind}\u0000${event.messageId}\u0000${event.providerAssetId}`;
    const previous = latest.get(key); if (!previous || previous.seq < event.seq) latest.set(key, event);
  }
  return [...latest.values()].sort((a, b) => (a.origin ?? a.seq) - (b.origin ?? b.seq) || a.seq - b.seq);
}

export async function listNativeMedia(sessionId: string): Promise<NativeMediaItem[]> {
  if (!await getSession(sessionId)) return [];
  return (await canonicalMedia(sessionId)).map(event => nativeMediaItem(sessionId, event));
}

async function exactMedia(sessionId: string, messageId: string, assetId: string): Promise<MediaEvent> {
  const found = (await canonicalMedia(sessionId)).filter(event => event.messageId === messageId && event.providerAssetId === assetId);
  if (found.length !== 1) throw new Error('Generated media was not found uniquely in this session'); return found[0]!;
}

export async function nativeMediaConversation(sessionId: string, messageId: string, assetId: string): Promise<string> {
  const session = await getSession(sessionId); if (!session) throw new Error('Session was not found');
  const event = await exactMedia(sessionId, messageId, assetId);
  const lineage = [...new Set([...session.chatIds, ...(session.conversationId ? [session.conversationId] : [])])];
  const conversationId = event.conversationId ?? (lineage.length === 1 ? lineage[0] : undefined);
  if (!conversationId || !lineage.includes(conversationId)) throw new Error('The original chat for this media is not recorded. Open the original output in the provider.');
  return conversationId;
}

export async function getNativeMediaItem(sessionId: string, messageId: string, assetId: string): Promise<NativeMediaItem> {
  if (!await getSession(sessionId)) throw new Error('Session was not found');
  return nativeMediaItem(sessionId, await exactMedia(sessionId, messageId, assetId));
}

export async function saveNativeMediaToProject(sessionId: string, messageId: string, assetId: string): Promise<NativeMediaSaveResult> {
  const session = await getSession(sessionId); if (!session?.conversationId || !session.projectId) throw new Error('Link this chat to a local project before saving generated media');
  const conversationId = await nativeMediaConversation(sessionId, messageId, assetId);
  const event = await exactMedia(sessionId, messageId, assetId);
  if (!canExportNativeOutput(conversationId, event.kind === 'native_image' ? 'image' : 'video')) throw new Error('Original media export is not available for this provider yet');
  if (event.providerStatus !== 'finished_successfully') throw new Error('The provider has not finished this generated media yet');
  const workspace = await getSessionProject(sessionId); if (!workspace) throw new Error('The session project is unavailable');
  // Provider message ids may contain Windows-forbidden punctuation or a common prefix.
  // A digest keeps filenames portable and distinct without changing the witnessed identity.
  const directory = 'generated-media'; const stem = `${createHash('sha256').update(messageId).digest('hex').slice(0, 16)}-${assetId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64)}`;
  const real = path.join(workspace.real, directory, stem), virtual = `${workspace.virtual}/${directory}/${stem}`.replace(/\\/g, '/');
  const validate = async () => {
    const live = await getSession(sessionId), current = await getSessionProject(sessionId);
    if (live?.projectId !== session.projectId || !current || nativePathIdentity(current.real) !== nativePathIdentity(workspace.real)) throw new Error('The project changed while saving media.');
    const resolved = await resolvePath(getConfig().roots, virtual, { allowMissing: true });
    if (nativePathIdentity(resolved.real) !== nativePathIdentity(real)) throw new Error('The media destination changed.');
    if (await nativeMediaConversation(sessionId, messageId, assetId) !== conversationId) throw new Error('Media ownership changed.');
  };
  await validate();
  if (event.kind === 'native_image') {
    const result = await exportImage({ conversationId, messageId, assetId }, { real, virtual, validate });
    const ext = result.format === 'jpeg' ? '.jpg' : `.${result.format}`;
    return { kind: 'image', projectId: session.projectId, relativePath: `${directory}/${stem}${ext}`, bytes: result.bytes, mimeType: `image/${result.format}` };
  }
  const result = await exportVideo({ conversationId, messageId, assetId, mimeType: event.mimeType }, { real, virtual, validate });
  const ext = event.mimeType === 'video/mp4' ? '.mp4' : '.webm';
  return { kind: 'video', projectId: session.projectId, relativePath: `${directory}/${stem}${ext}`, bytes: result.bytes, mimeType: result.mimeType };
}

export async function prepareNativeVideoPlayback(sessionId: string, messageId: string, assetId: string): Promise<NativeVideoPlayback> {
  await reapPlaybacks();
  const session = await getSession(sessionId); if (!session?.conversationId) throw new Error('Session provider identity is unavailable');
  const conversationId = await nativeMediaConversation(sessionId, messageId, assetId);
  if (!canExportNativeOutput(conversationId, 'video')) throw new Error('Original video playback is not available for this provider yet');
  const event = await exactMedia(sessionId, messageId, assetId); if (event.kind !== 'native_video') throw new Error('This generated media is not a video');
  if (event.providerStatus !== 'finished_successfully') throw new Error('The provider has not finished this video yet');
  const token = randomUUID(), dir = await playbackDirectory();
  const real = path.join(dir, token), ext = event.mimeType === 'video/mp4' ? '.mp4' : '.webm';
  const result = await exportVideo({ conversationId, messageId, assetId, mimeType: event.mimeType }, { real, virtual: `temporary-media/${token}` });
  try { if (!await getSession(sessionId) || await nativeMediaConversation(sessionId, messageId, assetId) !== conversationId) throw new Error('Media ownership changed during transfer.'); }
  catch (error) { await fs.rm(`${real}${ext}`, { force: true }); throw error; }
  const file = `${real}${ext}`, playback: Playback = { sessionId, file, mimeType: event.mimeType, bytes: result.bytes, expiresAt: 0 };
  playbacks.set(token, playback); touchPlayback(token, playback);
  return { token, mimeType: event.mimeType, bytes: result.bytes };
}

export async function readNativeVideoPlaybackChunk(sessionId: string, token: string, offset: number, maxBytes = PLAYBACK_CHUNK_BYTES): Promise<NativeVideoPlaybackChunk> {
  await reapPlaybacks(); const value = playbacks.get(token);
  if (!value || value.sessionId !== sessionId || Date.now() >= value.expiresAt) throw new Error('Video playback has expired');
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > value.bytes) throw new Error('Invalid video playback offset');
  const size = Math.max(1, Math.min(PLAYBACK_CHUNK_BYTES, Math.floor(maxBytes), value.bytes - offset || 1));
  const handle = await fs.open(value.file, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(size, Math.max(0, value.bytes - offset))); const { bytesRead } = buffer.length ? await handle.read(buffer, 0, buffer.length, offset) : { bytesRead: 0 };
    const nextOffset = offset + bytesRead; touchPlayback(token, value);
    return { data: buffer.subarray(0, bytesRead).toString('base64'), offset, nextOffset, totalBytes: value.bytes, done: nextOffset >= value.bytes };
  } finally { await handle.close(); }
}

export async function releaseNativeVideoPlayback(sessionId: string, token: string): Promise<boolean> {
  const value = playbacks.get(token); if (!value || value.sessionId !== sessionId) return false; await removePlayback(token, value); return true;
}
